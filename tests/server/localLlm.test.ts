import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createGeminiMiddleware } from '../../server/geminiService.ts';
import {
  LocalLlmError,
  buildChatRequest,
  buildLocalErrorPayload,
  contentsToMessages,
  geminiSchemaToJsonSchema,
  getProviderMode,
  isLocalCompatible,
  mapChatResponse,
  readLocalLlmConfig,
  resetLocalLlmCache,
  stripCodeFence,
} from '../../server/localLlm.ts';
import { assembleWebBook } from '../../src/services/evolutionService.ts';
import type { WebPageGenotype } from '../../src/types.ts';

// The local-model provider answers the Gemini-shaped generate endpoint with a model on the user's own machine (Ollama, LM Studio,
// llama-server ...). These tests run it against a fake OpenAI-compatible server over real HTTP, so the whole path - request
// translation, provider choice, failure handling, and a full book - is covered without a GPU or any network access.

console.warn = () => {};
const realFetch = globalThis.fetch;
const envKeys = ['LLM_PROVIDER', 'LOCAL_LLM_ENGINE', 'LOCAL_LLM_MODEL_PATH', 'LOCAL_LLM_MODEL_URI', 'LOCAL_LLM_MODELS_DIR', 'LOCAL_LLM_BASE_URL', 'LOCAL_LLM_MODEL', 'LOCAL_LLM_TIMEOUT_MS', 'LOCAL_LLM_MAX_CONCURRENCY', 'LOCAL_LLM_TEMPERATURE', 'GEMINI_API_KEY', 'GEMINI_MAX_ATTEMPTS'] as const;
const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const setEnv = (values: Partial<Record<(typeof envKeys)[number], string | undefined>>) => {
  for (const key of envKeys) delete process.env[key];
  // These tests are about external servers: the built-in runtime (and any model a developer has downloaded) must not take part.
  for (const [key, value] of Object.entries({ LOCAL_LLM_ENGINE: 'http', ...values })) if (value !== undefined) process.env[key] = value;
  resetLocalLlmCache();
};

// ---------------------------------------------------------------------------------------------------------------------
// 1. Request / response translation
// ---------------------------------------------------------------------------------------------------------------------
{
  // Gemini's schema dialect becomes plain JSON Schema; objects without `required` get every property required.
  const schema = {
    type: 'OBJECT',
    properties: {
      topic: { type: 'STRING' },
      outline: { type: 'ARRAY', items: { type: 'OBJECT', properties: { title: { type: 'STRING' }, terms: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['title'] } },
      note: { type: 'STRING', nullable: true },
      level: { type: 'STRING', enum: ['a', 'b'] },
    },
    required: ['topic', 'outline'],
  };
  const converted = geminiSchemaToJsonSchema(schema);
  assert.equal(converted.type, 'object');
  assert.deepEqual(converted.required, ['topic', 'outline']);
  assert.equal(converted.additionalProperties, false);
  assert.equal(converted.properties.outline.type, 'array');
  assert.equal(converted.properties.outline.items.type, 'object');
  assert.deepEqual(converted.properties.outline.items.required, ['title']);
  assert.deepEqual(converted.properties.note.type, ['string', 'null']);
  assert.deepEqual(converted.properties.level.enum, ['a', 'b']);
  const noRequired = geminiSchemaToJsonSchema({ type: 'OBJECT', properties: { term: { type: 'STRING' }, description: { type: 'STRING' } } });
  assert.deepEqual(noRequired.required, ['term', 'description']);
  assert.deepEqual(geminiSchemaToJsonSchema({ type: 'ARRAY', items: { type: 'STRING' }, minItems: '2' }), { type: 'array', items: { type: 'string' }, minItems: 2 });

  // contents -> messages
  assert.deepEqual(contentsToMessages('hello'), [{ role: 'user', content: 'hello' }]);
  assert.deepEqual(contentsToMessages('hello', 'be brief'), [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hello' }]);
  assert.deepEqual(contentsToMessages({ parts: [{ text: 'a' }, { text: 'b' }] }, { parts: [{ text: 'sys' }] }), [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'a\nb' },
  ]);
  assert.deepEqual(contentsToMessages([{ role: 'user', parts: [{ text: 'q' }] }, { role: 'model', parts: [{ text: 'a' }] }, { role: 'user', parts: [{ text: 'q2' }] }]).map((m) => m.role), ['user', 'assistant', 'user']);
  assert.throws(() => contentsToMessages([{ parts: [{ inlineData: { mimeType: 'image/png', data: 'x' } }] }]), LocalLlmError);
  assert.throws(() => contentsToMessages('   '), LocalLlmError);

  // Only text requests are local-compatible; search grounding and tools never are.
  assert.deepEqual(isLocalCompatible({ contents: 'x' }), { ok: true });
  assert.deepEqual(isLocalCompatible({ contents: 'x', config: { tools: [{ googleSearch: {} }] } }), { ok: false, why: 'grounding' });
  assert.deepEqual(isLocalCompatible({ contents: 'x', config: { tools: [{ functionDeclarations: [] }] } }), { ok: false, why: 'unsupported' });
  assert.deepEqual(isLocalCompatible({ contents: [{ parts: [{ inlineData: {} }] }] }), { ok: false, why: 'unsupported' });

  // chat request
  const request = buildChatRequest(
    { contents: 'write', config: { systemInstruction: 'sys', responseMimeType: 'application/json', responseSchema: schema, maxOutputTokens: 4096, topP: 0.9, stopSequences: ['END'] } },
    'gemma4:e4b',
    { temperature: 0.4 }
  );
  assert.equal(request.model, 'gemma4:e4b');
  assert.equal(request.temperature, 0.4, 'a low default temperature for a small model');
  assert.equal(request.max_tokens, 4096);
  assert.equal(request.top_p, 0.9);
  assert.deepEqual(request.stop, ['END']);
  assert.equal(request.stream, false);
  assert.equal(request.messages[0].role, 'system');
  assert.equal(request.response_format.type, 'json_schema');
  assert.equal(request.response_format.json_schema.schema.type, 'object');
  assert.equal(buildChatRequest({ contents: 'x', config: { temperature: 1.2 } }, 'm', { temperature: 0.4 }).temperature, 1.2, 'an explicit temperature is respected');
  assert.deepEqual(buildChatRequest({ contents: 'x', config: { responseMimeType: 'application/json' } }, 'm', { temperature: 0.4 }).response_format, { type: 'json_object' });
  assert.equal(buildChatRequest({ contents: 'x' }, 'm', { temperature: 0.4 }).response_format, undefined);

  // response mapping
  const mapped = mapChatResponse({ choices: [{ message: { content: '```json\n{"a":1}\n```' }, finish_reason: 'length' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }, true, 'gemma4:e4b');
  assert.equal(mapped.text, '{"a":1}', 'a code fence around JSON is removed');
  assert.equal(mapped.candidates[0].finishReason, 'MAX_TOKENS');
  assert.deepEqual(mapped.usageMetadata, { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 });
  assert.equal(mapped.modelUsed, 'gemma4:e4b (local)');
  assert.equal(mapChatResponse({ choices: [{ message: { content: '```json\nnot json```' }, finish_reason: 'stop' }] }, false, 'm').text.startsWith('```'), true, 'plain text is not touched');
  assert.throws(() => mapChatResponse({ choices: [{ message: { content: '  ' } }] }, false, 'm'), LocalLlmError);
  assert.equal(stripCodeFence('{"x":1}'), '{"x":1}');

  // configuration
  assert.deepEqual(readLocalLlmConfig({ LOCAL_LLM_BASE_URL: 'http://127.0.0.1:1234/v1/', LOCAL_LLM_MODEL: 'qwen3:8b', LOCAL_LLM_MAX_CONCURRENCY: '0' } as any), {
    baseUrl: 'http://127.0.0.1:1234', model: 'qwen3:8b', timeoutMs: 300000, maxConcurrency: 1, temperature: 0.4, engine: 'auto',
  });
  assert.equal(readLocalLlmConfig({ LOCAL_LLM_ENGINE: 'Embedded' } as any).engine, 'embedded');
  assert.equal(readLocalLlmConfig({ LOCAL_LLM_ENGINE: 'http' } as any).engine, 'http');
  assert.equal(readLocalLlmConfig({ LOCAL_LLM_ENGINE: 'nonsense' } as any).engine, 'auto');
  assert.equal(readLocalLlmConfig({} as any).model, 'gemma4:e4b');
  assert.equal(getProviderMode({ LLM_PROVIDER: 'LOCAL' } as any), 'local');
  assert.equal(getProviderMode({ LLM_PROVIDER: 'nonsense' } as any), 'auto');
  assert.equal(getProviderMode({} as any), 'auto');
}

// ---------------------------------------------------------------------------------------------------------------------
// A fake OpenAI-compatible model server (what Ollama / LM Studio / llama-server look like to the engine)
// ---------------------------------------------------------------------------------------------------------------------
interface FakeLlm {
  url: string;
  requests: any[];
  models: string[];
  delayMs: number;
  peakInFlight: number;
  fenceJson: boolean;
  setReplyForUnknownModel: (flag: boolean) => void;
  /** Resolves once no request is being worked on (a client that timed out leaves its request running on the server). */
  idle: () => Promise<void>;
  close: () => Promise<void>;
}

const chapterText = (n: number) => Array.from({ length: 160 }, (_, i) => `word${n}x${i}`).join(' ') + '.';
const outline = Array.from({ length: 10 }, (_, i) => ({
  title: `Local chapter ${i + 1}`,
  focus: 'Focus one. Focus two.',
  terms: ['alpha', 'beta', 'gamma', 'delta'],
  subTopicTitles: ['one', 'two', 'three'],
  visualSeed: `seed ${i}`,
}));

async function startFakeLlm(initialModels = ['gemma4:e4b']): Promise<FakeLlm> {
  let inFlight = 0;
  let rejectUnknownModel = true;
  const fake: FakeLlm = {
    url: '', requests: [], models: initialModels, delayMs: 0, peakInFlight: 0, fenceJson: false,
    setReplyForUnknownModel: (flag) => { rejectUnknownModel = !flag; },
    idle: async () => { while (inFlight > 0) await new Promise((resolve) => setTimeout(resolve, 10)); },
    close: async () => { server.closeAllConnections?.(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
  const server = http.createServer(async (req, res) => {
    const send = (status: number, payload: unknown) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(payload)); };
    if (req.method === 'GET' && req.url === '/v1/models') return send(200, { object: 'list', data: fake.models.map((id) => ({ id, object: 'model' })) });
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      fake.requests.push(body);
      inFlight += 1;
      fake.peakInFlight = Math.max(fake.peakInFlight, inFlight);
      try {
        if (fake.delayMs) await new Promise((resolve) => setTimeout(resolve, fake.delayMs));
        if (rejectUnknownModel && !fake.models.some((m) => m === body.model)) return send(404, { error: { message: `model '${body.model}' not found`, type: 'not_found_error' } });
        const schema = body.response_format?.json_schema?.schema;
        const prompt = body.messages.map((m: any) => m.content).join('\n');
        let content = 'OK';
        if (schema?.properties?.outline) {
          content = JSON.stringify({ topic: 'T', outline });
        } else if (schema?.properties?.content) {
          const n = Number(prompt.match(/Chapter (\d+): /)?.[1] ?? 0);
          content = JSON.stringify({
            content: chapterText(n),
            definitions: [{ term: `Term ${n}`, description: 'A clear description of this term in context.' }],
            subTopics: [{ title: `Angle ${n}`, summary: 'A short analysis of this angle on the topic.' }],
          });
        } else if (body.response_format) {
          content = '{"ok":true}';
        }
        if (fake.fenceJson && body.response_format) content = '```json\n' + content + '\n```';
        return send(200, { choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 } });
      } finally {
        inFlight -= 1;
      }
    }
    send(404, { error: { message: 'unknown route' } });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}

// The app's own gateway (the real middleware), on an ephemeral port.
const gateway = http.createServer((req, res) => {
  void createGeminiMiddleware()(req, res, () => { res.statusCode = 404; res.end(JSON.stringify({ error: { message: 'no route' } })); });
});
await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', () => resolve()));
const gatewayUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;

const post = async (path: string, body: unknown) => {
  const response = await realFetch(`${gatewayUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* stream */ }
  return { status: response.status, json, text };
};
const get = async (path: string) => {
  const response = await realFetch(`${gatewayUrl}${path}`);
  return { status: response.status, json: await response.json() as any };
};

// Words the client's own retry logic reacts to: an error message containing one would be retried / failed over to other models.
const RETRY_TRIGGERS = /(429|503|403|401|quota|unavailable|high demand|resource_exhausted|not found|no longer available|api_key|unauthenticated|invalid api key)/i;

// Google is never reached from a test: any call to it is answered with "API key not valid" (what Google says for a bad key).
let googleCalls = 0;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  if (/googleapis\.com/.test(url)) {
    googleCalls += 1;
    return new Response(JSON.stringify({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com' }] } }), { status: 400, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(input, init);
}) as typeof fetch;

// ---------------------------------------------------------------------------------------------------------------------
// 2. LLM_PROVIDER=local
// ---------------------------------------------------------------------------------------------------------------------
const fake = await startFakeLlm(['gemma4:e4b', 'qwen3:8b']);
{
  setEnv({ LLM_PROVIDER: 'local', LOCAL_LLM_BASE_URL: fake.url });
  const plain = await post('/api/gemini/generate', { model: 'gemini-3.6-flash', contents: 'Say hi', config: { systemInstruction: 'Be brief.' } });
  assert.equal(plain.status, 200);
  assert.equal(plain.json.text, 'OK');
  assert.equal(plain.json.provider, 'local');
  assert.equal(plain.json.modelUsed, 'gemma4:e4b (local)');
  assert.equal(plain.json.candidates[0].content.parts[0].text, 'OK');
  assert.deepEqual(plain.json.usageMetadata, { promptTokenCount: 12, candidatesTokenCount: 34, totalTokenCount: 46 });
  const sent = fake.requests.at(-1);
  assert.equal(sent.model, 'gemma4:e4b', 'the Gemini model name is never forwarded to the local server');
  assert.equal(sent.messages[0].role, 'system');
  assert.equal(googleCalls, 0, 'local mode never calls Google');

  // JSON schema request: schema translated, fenced output cleaned.
  fake.fenceJson = true;
  const structured = await post('/api/gemini/generate', {
    model: 'gemini-3.6-flash',
    contents: 'outline',
    config: { responseMimeType: 'application/json', responseSchema: { type: 'OBJECT', properties: { topic: { type: 'STRING' }, outline: { type: 'ARRAY', items: { type: 'OBJECT', properties: { title: { type: 'STRING' } } } } }, required: ['topic', 'outline'] } },
  });
  fake.fenceJson = false;
  assert.equal(structured.status, 200);
  assert.doesNotThrow(() => JSON.parse(structured.json.text), 'JSON the model wrapped in a fence is still valid JSON for the client');
  assert.equal(fake.requests.at(-1).response_format.json_schema.schema.properties.outline.items.type, 'object');

  // A model name that is not a Gemini name selects the local model explicitly.
  await post('/api/gemini/generate', { model: 'qwen3:8b', contents: 'x' });
  assert.equal(fake.requests.at(-1).model, 'qwen3:8b');

  // Search grounding is Google-only: answered exactly like a missing key, so the client uses its own web search.
  const before = fake.requests.length;
  const grounded = await post('/api/gemini/generate', { model: 'gemini-3.6-flash', contents: 'search', config: { tools: [{ googleSearch: {} }] } });
  assert.equal(grounded.status, 401);
  assert.equal(grounded.json.error.reason, 'missing_api_key');
  assert.equal(fake.requests.length, before, 'a grounded request never reaches the local model');
  assert.equal(googleCalls, 0);

  // Images are refused with a final, non-retryable error.
  const image = await post('/api/gemini/generate', { contents: [{ parts: [{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }] }] });
  assert.equal(image.status, 400);
  assert.equal(image.json.error.reason, 'local_unsupported');
  assert.equal(image.json.error.retriesExhausted, true);
}

// ---------------------------------------------------------------------------------------------------------------------
// 3. LLM_PROVIDER=auto and gemini
// ---------------------------------------------------------------------------------------------------------------------
{
  // auto, no key, local model ready -> local
  setEnv({ LOCAL_LLM_BASE_URL: fake.url });
  const viaLocal = await post('/api/gemini/generate', { model: 'gemini-3.6-flash', contents: 'x' });
  assert.equal(viaLocal.status, 200);
  assert.equal(viaLocal.json.provider, 'local');

  // auto, no key, local server running but the model is not installed (and several others are) -> not ready: the usual missing-key answer
  setEnv({ LOCAL_LLM_BASE_URL: fake.url, LOCAL_LLM_MODEL: 'not-installed:1b' });
  const notReady = await post('/api/gemini/generate', { contents: 'x' });
  assert.equal(notReady.status, 401);
  assert.equal(notReady.json.error.reason, 'missing_api_key');

  // auto, no key, no local server at all (the setup of anyone who has not installed one): exactly the missing-key answer as before
  setEnv({ LOCAL_LLM_BASE_URL: 'http://127.0.0.1:9' });
  const noServer = await post('/api/gemini/generate', { contents: 'x' });
  assert.equal(noServer.status, 401);
  assert.equal(noServer.json.error.reason, 'missing_api_key');
  assert.equal(googleCalls, 0);

  // gemini mode never uses a running local model
  setEnv({ LLM_PROVIDER: 'gemini', LOCAL_LLM_BASE_URL: fake.url });
  const before = fake.requests.length;
  const geminiOnly = await post('/api/gemini/generate', { contents: 'x' });
  assert.equal(geminiOnly.status, 401);
  assert.equal(fake.requests.length, before);

  // a single-model server (llama-server, LM Studio): its one model answers whatever LOCAL_LLM_MODEL says
  const single = await startFakeLlm(['some-model.gguf']);
  setEnv({ LOCAL_LLM_BASE_URL: single.url });
  const viaSingle = await post('/api/gemini/generate', { contents: 'x' });
  assert.equal(viaSingle.status, 200);
  assert.equal(single.requests.at(-1).model, 'some-model.gguf');
  assert.equal(viaSingle.json.modelUsed, 'some-model.gguf (local)');
  await single.close();

  // a tag alias: "gemma4" is the same model as "gemma4:latest"
  const alias = await startFakeLlm(['gemma4:latest', 'other:1b']);
  alias.setReplyForUnknownModel(false);
  setEnv({ LOCAL_LLM_BASE_URL: alias.url, LOCAL_LLM_MODEL: 'gemma4' });
  const viaAlias = await post('/api/gemini/generate', { contents: 'x' });
  assert.equal(viaAlias.status, 200);
  assert.equal(alias.requests.at(-1).model, 'gemma4:latest');
  await alias.close();
}

// ---------------------------------------------------------------------------------------------------------------------
// 4. A Gemini key that Google rejects fails over to the local model; other cases keep Google's own answer
// ---------------------------------------------------------------------------------------------------------------------
{
  setEnv({ LOCAL_LLM_BASE_URL: fake.url, GEMINI_API_KEY: 'AIzaSyFAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKE12', GEMINI_MAX_ATTEMPTS: '1' });
  googleCalls = 0;
  const failedOver = await post('/api/gemini/generate', { model: 'gemini-3.6-flash', contents: 'x' });
  assert.equal(googleCalls, 1, 'Google is tried first');
  assert.equal(failedOver.status, 200, 'a rejected key is answered by the local model');
  assert.equal(failedOver.json.provider, 'local');

  // search grounding with a rejected key stays Google's error: a local model cannot search
  const groundedBefore = fake.requests.length;
  const grounded = await post('/api/gemini/generate', { contents: 'search', config: { tools: [{ googleSearch: {} }] } });
  assert.notEqual(grounded.status, 200);
  assert.equal(grounded.json.error.reason, 'invalid_api_key');
  assert.equal(fake.requests.length, groundedBefore);

  // local model not running: Google's error (the one the user can act on) is reported, not a local one
  setEnv({ LOCAL_LLM_BASE_URL: 'http://127.0.0.1:9', GEMINI_API_KEY: 'AIzaSyFAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKE12', GEMINI_MAX_ATTEMPTS: '1' });
  const noLocal = await post('/api/gemini/generate', { contents: 'x' });
  assert.notEqual(noLocal.status, 200);
  assert.equal(noLocal.json.error.reason, 'invalid_api_key');

  // gemini mode with a rejected key: no failover at all
  setEnv({ LLM_PROVIDER: 'gemini', LOCAL_LLM_BASE_URL: fake.url, GEMINI_API_KEY: 'AIzaSyFAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKE12', GEMINI_MAX_ATTEMPTS: '1' });
  const beforeGemini = fake.requests.length;
  const strict = await post('/api/gemini/generate', { contents: 'x' });
  assert.notEqual(strict.status, 200);
  assert.equal(fake.requests.length, beforeGemini);
}

// ---------------------------------------------------------------------------------------------------------------------
// 5. Failure handling: final errors with messages the client will not retry
// ---------------------------------------------------------------------------------------------------------------------
{
  // not running
  setEnv({ LLM_PROVIDER: 'local', LOCAL_LLM_BASE_URL: 'http://127.0.0.1:9' });
  const down = await post('/api/gemini/generate', { contents: 'x' });
  assert.equal(down.status, 424);
  assert.equal(down.json.error.reason, 'local_unreachable');
  assert.equal(down.json.error.retriesExhausted, true);
  assert.doesNotMatch(down.json.error.message, RETRY_TRIGGERS);

  // running, model not installed (404 from the server)
  setEnv({ LLM_PROVIDER: 'local', LOCAL_LLM_BASE_URL: fake.url, LOCAL_LLM_MODEL: 'missing:7b' });
  const missing = await post('/api/gemini/generate', { contents: 'x' });
  assert.equal(missing.status, 424);
  assert.equal(missing.json.error.reason, 'local_model_missing');
  assert.match(missing.json.error.message, /ollama pull/);
  assert.doesNotMatch(missing.json.error.message, RETRY_TRIGGERS);
  assert.equal(missing.json.error.details.model, 'missing:7b');

  // too slow
  setEnv({ LLM_PROVIDER: 'local', LOCAL_LLM_BASE_URL: fake.url, LOCAL_LLM_TIMEOUT_MS: '150' });
  fake.delayMs = 600;
  const slow = await post('/api/gemini/generate', { contents: 'x' });
  fake.delayMs = 0;
  assert.equal(slow.status, 424);
  assert.equal(slow.json.error.reason, 'local_timeout');
  assert.doesNotMatch(slow.json.error.message, RETRY_TRIGGERS);

  // every local error message is safe for the client
  for (const reason of ['local_unreachable', 'local_model_missing', 'local_timeout', 'local_bad_response', 'local_rejected', 'local_unsupported'] as const) {
    const messages: Record<string, string> = {
      local_bad_response: 'The local model returned no text.',
      local_rejected: 'The local model server rejected the request.',
    };
    if (messages[reason]) assert.doesNotMatch(messages[reason], RETRY_TRIGGERS, reason);
    assert.equal(buildLocalErrorPayload(new LocalLlmError(reason, 'x')).payload.error.retriesExhausted, true);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// 6. Concurrency: a laptop model answers one request at a time unless told otherwise
// ---------------------------------------------------------------------------------------------------------------------
{
  await fake.idle();
  setEnv({ LLM_PROVIDER: 'local', LOCAL_LLM_BASE_URL: fake.url, LOCAL_LLM_MAX_CONCURRENCY: '1' });
  fake.peakInFlight = 0;
  fake.delayMs = 40;
  const serial = await Promise.all([1, 2, 3, 4].map((n) => post('/api/gemini/generate', { contents: `q${n}` })));
  assert.ok(serial.every((r) => r.status === 200));
  assert.equal(fake.peakInFlight, 1, 'one request in flight at a time by default');

  setEnv({ LLM_PROVIDER: 'local', LOCAL_LLM_BASE_URL: fake.url, LOCAL_LLM_MAX_CONCURRENCY: '2' });
  fake.peakInFlight = 0;
  const pair = await Promise.all([1, 2, 3, 4].map((n) => post('/api/gemini/generate', { contents: `q${n}` })));
  fake.delayMs = 0;
  assert.ok(pair.every((r) => r.status === 200));
  assert.equal(fake.peakInFlight, 2, 'LOCAL_LLM_MAX_CONCURRENCY raises the limit');
}

// ---------------------------------------------------------------------------------------------------------------------
// 7. Stream endpoint, health endpoint, model list
// ---------------------------------------------------------------------------------------------------------------------
{
  setEnv({ LLM_PROVIDER: 'local', LOCAL_LLM_BASE_URL: fake.url });
  const stream = await post('/api/gemini/stream', { contents: 'x' });
  assert.equal(stream.status, 200);
  const events = stream.text.split('\n\n').filter(Boolean).map((e) => e.replace(/^data: /, ''));
  assert.equal(events.at(-1), '[DONE]');
  assert.equal(JSON.parse(events[0]).text, 'OK');
  assert.equal(JSON.parse(events[0]).provider, 'local');

  const health = await get('/api/local-llm/health');
  assert.equal(health.json.reachable, true);
  assert.equal(health.json.ready, true);
  assert.deepEqual(health.json.models, ['gemma4:e4b', 'qwen3:8b']);
  assert.equal(health.json.hint, undefined);

  setEnv({ LOCAL_LLM_BASE_URL: fake.url, LOCAL_LLM_MODEL: 'missing:7b' });
  const noModel = await get('/api/local-llm/health');
  assert.equal(noModel.json.ready, false);
  assert.match(noModel.json.hint, /ollama pull missing:7b/);

  setEnv({ LOCAL_LLM_BASE_URL: 'http://127.0.0.1:9' });
  const off = await get('/api/local-llm/health');
  assert.equal(off.json.reachable, false);
  assert.match(off.json.hint, /ollama pull gemma4:e4b/);

  setEnv({ LOCAL_LLM_BASE_URL: fake.url });
  const models = await get('/api/gemini/models');
  assert.deepEqual(models.json.localModels, ['gemma4:e4b', 'qwen3:8b']);
  assert.equal(models.json.localReady, true);
  setEnv({ LLM_PROVIDER: 'gemini', LOCAL_LLM_BASE_URL: fake.url });
  assert.equal((await get('/api/gemini/models')).json.localModels, undefined, 'gemini mode does not advertise local models');
}

// ---------------------------------------------------------------------------------------------------------------------
// 8. End to end: a whole book written by the (fake) local model through the app's own endpoint
// ---------------------------------------------------------------------------------------------------------------------
{
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.window = { location: { origin: gatewayUrl, href: `${gatewayUrl}/` } };

  const page = (id: string, url: string, content: string): WebPageGenotype => ({
    id, url, title: `Title ${id}`, content,
    definitions: [], subTopics: [], informativeScore: 0.8, authorityScore: 0.8, fitness: 0,
  });
  const population = Array.from({ length: 6 }, (_, i) => page(`gen-${i}`, `https://example${i}.org/a`, `LOCAL-EVIDENCE-MARKER-${i} ` + 'Evidence sentence about the topic. '.repeat(20)));
  const searchResult = { sourceMode: 'fallback_search' as const, generationNote: 'Evidence gathered via DuckDuckGo fallback.', artifacts: { groundingChunks: [] } };

  setEnv({ LLM_PROVIDER: 'local', LOCAL_LLM_BASE_URL: fake.url, LOCAL_LLM_MAX_CONCURRENCY: '1' });
  fake.requests.length = 0;
  const book = await assembleWebBook(population, 'T', searchResult, { mode: 'google_duckduckgo', geminiModel: 'gemini-3.6-flash' });
  assert.equal(book.chapters.length, 10, 'ten chapters written by the local model');
  assert.ok(book.chapters.every((c) => /^Local chapter \d+$/.test(c.title)), 'titles come from the model outline');
  assert.ok(book.chapters.every((c) => c.content.split(/\s+/).length >= 150), 'chapters carry the model-written text');
  assert.match(book.generationNote || '', /answered by gemma4:e4b \(local\) instead of the selected gemini-3\.6-flash/);
  assert.equal(fake.requests.length, 11, 'one outline request and ten chapter requests');
  assert.ok(fake.requests.slice(1).every((r) => r.messages.at(-1).content.includes('LOCAL-EVIDENCE-MARKER-0')), 'every chapter prompt carries the gathered evidence');

  // Local model not running: the engine still delivers its extractive offline book, with the usual note.
  setEnv({ LLM_PROVIDER: 'local', LOCAL_LLM_BASE_URL: 'http://127.0.0.1:9' });
  const offline = await assembleWebBook(population, 'T', searchResult, { mode: 'google_duckduckgo', geminiModel: 'gemini-3.6-flash' });
  assert.ok(offline.chapters.length >= 1);
  assert.ok(!offline.chapters.some((c) => /^Local chapter/.test(c.title)));
  assert.match(offline.generationNote || '', /unavailable for book assembly/);

  delete globals.window;
}

// ---------------------------------------------------------------------------------------------------------------------
globalThis.fetch = realFetch;
for (const key of envKeys) {
  if (savedEnv[key] === undefined) delete process.env[key];
  else process.env[key] = savedEnv[key];
}
await fake.close();
await new Promise<void>((resolve) => { gateway.closeAllConnections?.(); gateway.close(() => resolve()); });
console.log('localLlm tests passed');
