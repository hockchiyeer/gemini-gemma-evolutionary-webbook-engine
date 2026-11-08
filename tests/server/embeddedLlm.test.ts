import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createGeminiMiddleware } from '../../server/geminiService.ts';
import {
  EmbeddedEngineError,
  disposeEmbeddedEngine,
  loadNodeLlamaCpp,
  setEmbeddedEngineForTests,
  type EmbeddedEngine,
  type EmbeddedRequest,
  type EmbeddedStatus,
} from '../../server/embeddedLlm.ts';
import { resetLocalLlmCache } from '../../server/localLlm.ts';
import { assembleWebBook } from '../../src/services/evolutionService.ts';
import type { WebPageGenotype } from '../../src/types.ts';

// The built-in engine as the app uses it: requests arrive at the real /api/gemini/* endpoints, and the engine behind them is a fake
// (routing, errors, limits, health, a whole book) or - in the last section - the real llama.cpp runtime on a tiny test model.

console.warn = () => {};
const realFetch = globalThis.fetch;
const envKeys = [
  'LLM_PROVIDER', 'LOCAL_LLM_ENGINE', 'LOCAL_LLM_BASE_URL', 'LOCAL_LLM_MODEL', 'LOCAL_LLM_MODEL_PATH', 'LOCAL_LLM_MODEL_URI', 'LOCAL_LLM_MODELS_DIR',
  'LOCAL_LLM_CONTEXT_SIZE', 'LOCAL_LLM_TIMEOUT_MS', 'LOCAL_LLM_MAX_CONCURRENCY', 'LOCAL_LLM_TEMPERATURE', 'LOCAL_LLM_THREADS', 'GEMINI_API_KEY', 'GEMINI_MAX_ATTEMPTS',
] as const;
const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const DEAD_SERVER = 'http://127.0.0.1:9';
const setEnv = (values: Partial<Record<(typeof envKeys)[number], string | undefined>> = {}) => {
  for (const key of envKeys) delete process.env[key];
  for (const [key, value] of Object.entries({ LOCAL_LLM_BASE_URL: DEAD_SERVER, ...values })) if (value !== undefined) process.env[key] = value;
  resetLocalLlmCache();
};

// ---------------------------------------------------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------------------------------------------------
const chapterText = (n: number) => Array.from({ length: 160 }, (_, i) => `engine${n}x${i}`).join(' ') + '.';
const outline = Array.from({ length: 10 }, (_, i) => ({
  title: `Built-in chapter ${i + 1}`, focus: 'Focus one. Focus two.', terms: ['alpha', 'beta', 'gamma', 'delta'], subTopicTitles: ['one', 'two', 'three'], visualSeed: `seed ${i}`,
}));

class FakeEngine implements EmbeddedEngine {
  statusValue: EmbeddedStatus = { available: true, modelPresent: true, modelName: 'gemma-fake-Q4', modelUri: 'hf:test/fake/gemma-fake-Q4.gguf', backend: 'cpu' };
  requests: EmbeddedRequest[] = [];
  statusCalls = 0;
  delayMs = 0;
  inFlight = 0;
  peak = 0;
  failWith: EmbeddedEngineError | null = null;

  async status() { this.statusCalls += 1; return this.statusValue; }
  async dispose() {}
  async complete(request: EmbeddedRequest) {
    this.requests.push(request);
    this.inFlight += 1;
    this.peak = Math.max(this.peak, this.inFlight);
    try {
      if (this.delayMs) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, this.delayMs);
          request.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new EmbeddedEngineError('aborted', 'stopped')); });
        });
      }
      if (this.failWith) throw this.failWith;
      const schema = request.jsonSchema as any;
      const prompt = request.messages.map((m) => m.content).join('\n');
      let text = 'OK';
      if (schema?.properties?.outline) text = JSON.stringify({ topic: 'T', outline });
      else if (schema?.properties?.content) {
        const n = Number(prompt.match(/Chapter (\d+): /)?.[1] ?? 0);
        text = JSON.stringify({ content: chapterText(n), definitions: [{ term: `Term ${n}`, description: 'A clear description of this term in context.' }], subTopics: [{ title: `Angle ${n}`, summary: 'A short analysis of this angle on the topic.' }] });
      } else if (request.jsonObject || schema) text = '{"ok":true}';
      return { text, finishReason: 'stop' as const, promptTokens: 21, completionTokens: 7, modelName: this.statusValue.modelName };
    } finally {
      this.inFlight -= 1;
    }
  }
}

/** A minimal external OpenAI-compatible server, to prove an external server wins over the built-in engine in auto mode. */
async function startHttpServer() {
  const requests: any[] = [];
  const server = http.createServer(async (req, res) => {
    const send = (status: number, payload: unknown) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(payload)); };
    if (req.url === '/v1/models') return send(200, { data: [{ id: 'gemma4:e4b' }] });
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    send(200, { choices: [{ message: { content: 'HTTP-ANSWER' }, finish_reason: 'stop' }], usage: {} });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, close: async () => { server.closeAllConnections?.(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}

const gateway = http.createServer((req, res) => {
  void createGeminiMiddleware()(req, res, () => { res.statusCode = 404; res.end(JSON.stringify({ error: { message: 'no route' } })); });
});
await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', () => resolve()));
const gatewayUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;

const post = async (route: string, body: unknown) => {
  const response = await realFetch(`${gatewayUrl}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* stream */ }
  return { status: response.status, json, text };
};
const get = async (route: string) => {
  const response = await realFetch(`${gatewayUrl}${route}`);
  return { status: response.status, json: (await response.json()) as any };
};

const RETRY_TRIGGERS = /(429|503|403|401|quota|unavailable|high demand|resource_exhausted|not found|no longer available|api_key|unauthenticated|invalid api key)/i;

// Google is never reached from a test.
let googleCalls = 0;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  if (/googleapis\.com/.test(url)) {
    googleCalls += 1;
    return new Response(JSON.stringify({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com' }] } }), { status: 400, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(input, init);
}) as typeof fetch;

const engine = new FakeEngine();
setEmbeddedEngineForTests(engine);

// ---------------------------------------------------------------------------------------------------------------------
// 1. LOCAL_LLM_ENGINE=embedded
// ---------------------------------------------------------------------------------------------------------------------
{
  setEnv({ LLM_PROVIDER: 'local', LOCAL_LLM_ENGINE: 'embedded' });
  const plain = await post('/api/gemini/generate', { model: 'gemini-3.6-flash', contents: 'Say hi', config: { systemInstruction: 'Be brief.', maxOutputTokens: 300, topP: 0.9, seed: 5, stopSequences: ['END'] } });
  assert.equal(plain.status, 200);
  assert.equal(plain.json.text, 'OK');
  assert.equal(plain.json.provider, 'local');
  assert.equal(plain.json.modelUsed, 'gemma-fake-Q4 (local)', 'the book is attributed to the model that really wrote it');
  assert.deepEqual(plain.json.usageMetadata, { promptTokenCount: 21, candidatesTokenCount: 7, totalTokenCount: 28 });
  const sent = engine.requests.at(-1)!;
  assert.deepEqual(sent.messages, [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Say hi' }]);
  assert.equal(sent.temperature, 0.4, 'a low default temperature');
  assert.equal(sent.maxTokens, 300);
  assert.equal(sent.topP, 0.9);
  assert.equal(sent.seed, 5);
  assert.deepEqual(sent.stop, ['END']);
  assert.equal(sent.jsonSchema, undefined);
  assert.equal(googleCalls, 0);

  // JSON schema: translated from Gemini's dialect before it reaches the grammar
  const structured = await post('/api/gemini/generate', {
    contents: 'outline',
    config: { responseMimeType: 'application/json', responseSchema: { type: 'OBJECT', properties: { topic: { type: 'STRING' }, outline: { type: 'ARRAY', items: { type: 'OBJECT', properties: { title: { type: 'STRING' } } } } }, required: ['topic', 'outline'] } },
  });
  assert.equal(structured.status, 200);
  assert.doesNotThrow(() => JSON.parse(structured.json.text));
  const schemaSent: any = engine.requests.at(-1)!.jsonSchema;
  assert.equal(schemaSent.type, 'object');
  assert.equal(schemaSent.properties.outline.items.type, 'object');
  assert.deepEqual(schemaSent.properties.outline.items.required, ['title']);

  await post('/api/gemini/generate', { contents: 'x', config: { responseMimeType: 'application/json' } });
  assert.equal(engine.requests.at(-1)!.jsonObject, true);

  // Search grounding and images stay out of reach, exactly as with the external-server path
  const before = engine.requests.length;
  const grounded = await post('/api/gemini/generate', { contents: 's', config: { tools: [{ googleSearch: {} }] } });
  assert.equal(grounded.status, 401);
  assert.equal(grounded.json.error.reason, 'missing_api_key');
  const image = await post('/api/gemini/generate', { contents: [{ parts: [{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }] }] });
  assert.equal(image.json.error.reason, 'local_unsupported');
  assert.equal(engine.requests.length, before);

  // stream endpoint
  const stream = await post('/api/gemini/stream', { contents: 'x' });
  const events = stream.text.split('\n\n').filter(Boolean).map((e) => e.replace(/^data: /, ''));
  assert.equal(events.at(-1), '[DONE]');
  assert.equal(JSON.parse(events[0]).modelUsed, 'gemma-fake-Q4 (local)');
}

// ---------------------------------------------------------------------------------------------------------------------
// 2. Choosing between an external server and the built-in engine (auto)
// ---------------------------------------------------------------------------------------------------------------------
{
  // no key, nothing external running, built-in model present -> built-in
  setEnv({ LOCAL_LLM_ENGINE: 'auto' });
  engine.requests.length = 0;
  const viaEmbedded = await post('/api/gemini/generate', { contents: 'x' });
  assert.equal(viaEmbedded.status, 200);
  assert.equal(viaEmbedded.json.modelUsed, 'gemma-fake-Q4 (local)');
  assert.equal(engine.requests.length, 1);

  // an external server that is ready wins: it is the one the user chose to run
  const external = await startHttpServer();
  setEnv({ LOCAL_LLM_ENGINE: 'auto', LOCAL_LLM_BASE_URL: external.url });
  engine.requests.length = 0;
  const viaHttp = await post('/api/gemini/generate', { contents: 'x' });
  assert.equal(viaHttp.json.text, 'HTTP-ANSWER');
  assert.equal(engine.requests.length, 0, 'the built-in engine stays idle while an external server answers');
  assert.equal(external.requests.length, 1);

  // http-only never touches the built-in engine, not even to ask its status
  setEnv({ LOCAL_LLM_ENGINE: 'http', LOCAL_LLM_BASE_URL: DEAD_SERVER });
  engine.statusCalls = 0;
  engine.requests.length = 0;
  const httpOnly = await post('/api/gemini/generate', { contents: 'x' });
  assert.equal(httpOnly.status, 401, 'no key and no external server: the usual missing-key answer (extractive book)');
  assert.equal(engine.statusCalls, 0);
  assert.equal(engine.requests.length, 0);
  await external.close();

  // built-in model not downloaded, nothing external: not ready, so the usual missing-key answer
  engine.statusValue = { ...engine.statusValue, modelPresent: false };
  setEnv({ LOCAL_LLM_ENGINE: 'auto' });
  const notReady = await post('/api/gemini/generate', { contents: 'x' });
  assert.equal(notReady.status, 401);
  assert.equal(notReady.json.error.reason, 'missing_api_key');
  engine.statusValue = { ...engine.statusValue, modelPresent: true };
}

// ---------------------------------------------------------------------------------------------------------------------
// 3. Failures: final, specific, and phrased so the client does not retry them
// ---------------------------------------------------------------------------------------------------------------------
{
  // model file missing, engine forced
  engine.statusValue = { ...engine.statusValue, modelPresent: false };
  setEnv({ LLM_PROVIDER: 'local', LOCAL_LLM_ENGINE: 'embedded' });
  const missing = await post('/api/gemini/generate', { contents: 'x' });
  assert.equal(missing.status, 424);
  assert.equal(missing.json.error.reason, 'local_model_missing');
  assert.match(missing.json.error.message, /npm run setup:local-llm/);
  assert.doesNotMatch(missing.json.error.message, RETRY_TRIGGERS);

  // model file missing, auto: the message names both ways out
  setEnv({ LLM_PROVIDER: 'local', LOCAL_LLM_ENGINE: 'auto' });
  const none = await post('/api/gemini/generate', { contents: 'x' });
  assert.equal(none.status, 424);
  assert.match(none.json.error.message, /Ollama or LM Studio/);
  assert.match(none.json.error.message, /npm run setup:local-llm/);
  assert.doesNotMatch(none.json.error.message, RETRY_TRIGGERS);

  // runtime cannot run on this machine
  engine.statusValue = { available: false, reason: 'unsupported platform', modelPresent: false, modelName: 'x', modelUri: 'u' };
  setEnv({ LLM_PROVIDER: 'local', LOCAL_LLM_ENGINE: 'embedded' });
  const noRuntime = await post('/api/gemini/generate', { contents: 'x' });
  assert.equal(noRuntime.status, 424);
  assert.equal(noRuntime.json.error.reason, 'local_unreachable');
  assert.match(noRuntime.json.error.message, /Ollama or LM Studio/);
  assert.doesNotMatch(noRuntime.json.error.message, RETRY_TRIGGERS);
  engine.statusValue = { available: true, modelPresent: true, modelName: 'gemma-fake-Q4', modelUri: 'hf:test/fake/gemma-fake-Q4.gguf', backend: 'cpu' };

  // engine-level failures map to final errors
  setEnv({ LLM_PROVIDER: 'local', LOCAL_LLM_ENGINE: 'embedded' });
  const cases: Array<[EmbeddedEngineError, string]> = [
    [new EmbeddedEngineError('prompt_too_long', "The prompt is longer than the local model's context window. Raise LOCAL_LLM_CONTEXT_SIZE (needs more memory) or use a model with a larger context.", { promptTokens: 9000, contextSize: 4096 }), 'local_rejected'],
    [new EmbeddedEngineError('failed', 'The local model failed while writing: out of memory'), 'local_rejected'],
    [new EmbeddedEngineError('unavailable', 'The built-in runtime could not load the model: not enough memory'), 'local_unreachable'],
    [new EmbeddedEngineError('aborted', 'stopped'), 'local_timeout'],
  ];
  for (const [error, reason] of cases) {
    engine.failWith = error;
    const failed = await post('/api/gemini/generate', { contents: 'x' });
    assert.equal(failed.status, 424, reason);
    assert.equal(failed.json.error.reason, reason);
    assert.equal(failed.json.error.retriesExhausted, true);
    assert.doesNotMatch(failed.json.error.message, RETRY_TRIGGERS, reason);
  }
  engine.failWith = null;
  const tooLong = await post('/api/gemini/generate', { contents: 'x' });
  assert.equal(tooLong.status, 200, 'the engine recovers after a failure');

  // the time limit aborts the engine's work
  setEnv({ LLM_PROVIDER: 'local', LOCAL_LLM_ENGINE: 'embedded', LOCAL_LLM_TIMEOUT_MS: '120' });
  engine.delayMs = 700;
  const slow = await post('/api/gemini/generate', { contents: 'x' });
  engine.delayMs = 0;
  assert.equal(slow.status, 424);
  assert.equal(slow.json.error.reason, 'local_timeout');
  assert.match(slow.json.error.message, /LOCAL_LLM_TIMEOUT_MS/);
  assert.equal(engine.requests.at(-1)!.signal?.aborted, true, 'the engine was told to stop');
}

// ---------------------------------------------------------------------------------------------------------------------
// 4. One request at a time on the built-in engine unless told otherwise
// ---------------------------------------------------------------------------------------------------------------------
{
  setEnv({ LLM_PROVIDER: 'local', LOCAL_LLM_ENGINE: 'embedded', LOCAL_LLM_MAX_CONCURRENCY: '1' });
  engine.peak = 0;
  engine.delayMs = 40;
  const serial = await Promise.all([1, 2, 3, 4].map((n) => post('/api/gemini/generate', { contents: `q${n}` })));
  assert.ok(serial.every((r) => r.status === 200));
  assert.equal(engine.peak, 1);

  setEnv({ LLM_PROVIDER: 'local', LOCAL_LLM_ENGINE: 'embedded', LOCAL_LLM_MAX_CONCURRENCY: '2' });
  engine.peak = 0;
  await Promise.all([1, 2, 3, 4].map((n) => post('/api/gemini/generate', { contents: `q${n}` })));
  engine.delayMs = 0;
  assert.equal(engine.peak, 2);
}

// ---------------------------------------------------------------------------------------------------------------------
// 5. A rejected Gemini key fails over to the built-in engine; search grounding stays Google's
// ---------------------------------------------------------------------------------------------------------------------
{
  setEnv({ LOCAL_LLM_ENGINE: 'auto', GEMINI_API_KEY: 'AIzaSyFAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKE12', GEMINI_MAX_ATTEMPTS: '1' });
  googleCalls = 0;
  const failedOver = await post('/api/gemini/generate', { contents: 'x' });
  assert.equal(googleCalls, 1);
  assert.equal(failedOver.status, 200);
  assert.equal(failedOver.json.provider, 'local');
  assert.equal(failedOver.json.modelUsed, 'gemma-fake-Q4 (local)');

  const grounded = await post('/api/gemini/generate', { contents: 's', config: { tools: [{ googleSearch: {} }] } });
  assert.equal(grounded.json.error.reason, 'invalid_api_key');
}

// ---------------------------------------------------------------------------------------------------------------------
// 6. Health endpoint
// ---------------------------------------------------------------------------------------------------------------------
{
  setEnv({ LOCAL_LLM_ENGINE: 'auto' });
  const ok = await get('/api/local-llm/health');
  assert.equal(ok.json.ready, true);
  assert.equal(ok.json.engine, 'embedded');
  assert.equal(ok.json.engineSetting, 'auto');
  assert.equal(ok.json.modelInUse, 'gemma-fake-Q4');
  assert.deepEqual(ok.json.embedded, { available: true, modelPresent: true, modelName: 'gemma-fake-Q4', modelUri: 'hf:test/fake/gemma-fake-Q4.gguf', backend: 'cpu' });
  assert.equal(ok.json.hint, undefined);

  engine.statusValue = { ...engine.statusValue, modelPresent: false };
  const auto = await get('/api/local-llm/health');
  assert.equal(auto.json.ready, false);
  assert.equal(auto.json.engine, 'none');
  assert.match(auto.json.hint, /ollama pull gemma4:e4b/);
  assert.match(auto.json.hint, /npm run setup:local-llm/);

  setEnv({ LOCAL_LLM_ENGINE: 'embedded' });
  const embeddedOnly = await get('/api/local-llm/health');
  assert.match(embeddedOnly.json.hint, /npm run setup:local-llm/);
  assert.doesNotMatch(embeddedOnly.json.hint, /ollama pull/);

  setEnv({ LOCAL_LLM_ENGINE: 'http' });
  const httpOnly = await get('/api/local-llm/health');
  assert.match(httpOnly.json.hint, /ollama pull gemma4:e4b/);
  assert.doesNotMatch(httpOnly.json.hint, /setup:local-llm/);
  assert.equal(httpOnly.json.embedded, undefined);
  engine.statusValue = { ...engine.statusValue, modelPresent: true };
}

// ---------------------------------------------------------------------------------------------------------------------
// 7. A whole book written through the built-in engine
// ---------------------------------------------------------------------------------------------------------------------
{
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.window = { location: { origin: gatewayUrl, href: `${gatewayUrl}/` } };
  const page = (id: string, url: string, content: string): WebPageGenotype => ({ id, url, title: `Title ${id}`, content, definitions: [], subTopics: [], informativeScore: 0.8, authorityScore: 0.8, fitness: 0 });
  const population = Array.from({ length: 6 }, (_, i) => page(`gen-${i}`, `https://example${i}.org/a`, `BUILTIN-EVIDENCE-MARKER-${i} ` + 'Evidence sentence about the topic. '.repeat(20)));
  const searchResult = { sourceMode: 'fallback_search' as const, generationNote: 'Evidence gathered via DuckDuckGo fallback.', artifacts: { groundingChunks: [] } };

  setEnv({ LLM_PROVIDER: 'auto', LOCAL_LLM_ENGINE: 'auto' });
  engine.requests.length = 0;
  const book = await assembleWebBook(population, 'T', searchResult, { mode: 'google_duckduckgo', geminiModel: 'gemini-3.6-flash' });
  assert.equal(book.chapters.length, 10);
  assert.ok(book.chapters.every((c) => /^Built-in chapter \d+$/.test(c.title)));
  assert.ok(book.chapters.every((c) => c.content.split(/\s+/).length >= 150));
  assert.match(book.generationNote || '', /answered by gemma-fake-Q4 \(local\) instead of the selected gemini-3\.6-flash/);
  assert.equal(engine.requests.length, 11, 'one outline and ten chapters');
  assert.ok(engine.requests.slice(1).every((r) => r.messages.at(-1)!.content.includes('BUILTIN-EVIDENCE-MARKER-0')), 'every chapter prompt carries the gathered evidence');
  delete globals.window;
}

// ---------------------------------------------------------------------------------------------------------------------
// 8. The same endpoint on the REAL llama.cpp runtime (tiny test model; skipped loudly if the runtime is not installed)
// ---------------------------------------------------------------------------------------------------------------------
let realRuntime = true;
try { await loadNodeLlamaCpp(); } catch { realRuntime = false; }
if (!realRuntime) {
  console.log('embeddedLlm: real-runtime section SKIPPED (node-llama-cpp is not installed)');
} else {
  setEmbeddedEngineForTests(null);
  const fixture = path.resolve('tests/fixtures/tiny-random.gguf');
  setEnv({ LLM_PROVIDER: 'local', LOCAL_LLM_ENGINE: 'embedded', LOCAL_LLM_MODEL_PATH: fixture, LOCAL_LLM_CONTEXT_SIZE: '2048' });

  const health = await get('/api/local-llm/health');
  assert.equal(health.json.ready, true, JSON.stringify(health.json));
  assert.equal(health.json.engine, 'embedded');
  assert.equal(health.json.embedded.available, true);
  assert.ok(health.json.embedded.backend);
  assert.equal(health.json.modelInUse, 'tiny-random');

  const schema = { type: 'OBJECT', properties: { kind: { type: 'STRING', enum: ['alpha', 'beta', 'gamma'] }, ok: { type: 'BOOLEAN' } }, required: ['kind', 'ok'] };
  const real = await post('/api/gemini/generate', { model: 'gemini-3.6-flash', contents: 'Describe something.', config: { systemInstruction: 'Answer in JSON.', maxOutputTokens: 80, responseMimeType: 'application/json', responseSchema: schema } });
  assert.equal(real.status, 200, real.text);
  assert.equal(real.json.provider, 'local');
  assert.equal(real.json.modelUsed, 'tiny-random (local)');
  const parsed = JSON.parse(real.json.text);
  assert.ok(['alpha', 'beta', 'gamma'].includes(parsed.kind), real.json.text);
  assert.equal(typeof parsed.ok, 'boolean');
  assert.equal(real.json.candidates[0].finishReason, 'STOP');

  const realStream = await post('/api/gemini/stream', { contents: 'x', config: { maxOutputTokens: 80, responseMimeType: 'application/json', responseSchema: schema } });
  const realEvents = realStream.text.split('\n\n').filter(Boolean).map((e) => e.replace(/^data: /, ''));
  assert.equal(realEvents.at(-1), '[DONE]');
  assert.ok(JSON.parse(JSON.parse(realEvents[0]).text).kind);

  // a prompt too big for the configured context is refused through the whole stack, with the fix named
  setEnv({ LLM_PROVIDER: 'local', LOCAL_LLM_ENGINE: 'embedded', LOCAL_LLM_MODEL_PATH: fixture, LOCAL_LLM_CONTEXT_SIZE: '2048' });
  const huge = await post('/api/gemini/generate', { contents: 'evidence '.repeat(6000) });
  assert.equal(huge.status, 424);
  assert.equal(huge.json.error.reason, 'local_rejected');
  assert.match(huge.json.error.message, /LOCAL_LLM_CONTEXT_SIZE/);
  await disposeEmbeddedEngine();
}

// ---------------------------------------------------------------------------------------------------------------------
setEmbeddedEngineForTests(null);
globalThis.fetch = realFetch;
for (const key of envKeys) {
  if (savedEnv[key] === undefined) delete process.env[key];
  else process.env[key] = savedEnv[key];
}
await new Promise<void>((resolve) => { gateway.closeAllConnections?.(); gateway.close(() => resolve()); });
console.log('embeddedLlm tests passed');
