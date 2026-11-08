/**
 * Local-model provider for the Gemini-shaped generate endpoint.
 *
 * The browser keeps sending Gemini-shaped requests ({ model, contents, config }) to /api/gemini/generate. When no Gemini
 * API key is usable, this module answers them with a model running on the user's own machine instead, through any server
 * that speaks the OpenAI-compatible chat API: Ollama (default http://localhost:11434), LM Studio, llama.cpp's llama-server, vLLM.
 *
 * Environment (all optional):
 *   LLM_PROVIDER              auto (default) | gemini | local
 *                             auto   = Gemini when its key works; otherwise a ready local model; otherwise the extractive offline book
 *                             gemini = never use a local model;  local = never call Google
 *   LOCAL_LLM_BASE_URL        default http://localhost:11434 (a trailing /v1 is accepted)
 *   LOCAL_LLM_MODEL           default gemma4:e4b
 *   LOCAL_LLM_TIMEOUT_MS      longest wait for ONE answer, default 300000 (0 = no limit)
 *   LOCAL_LLM_MAX_CONCURRENCY simultaneous requests to the local server, default 1 (a laptop GPU answers one at a time)
 *   LOCAL_LLM_TEMPERATURE     default 0.4 (Gemini's default of 1.0 is too hot for a small model writing from evidence)
 *   LOCAL_LLM_ENGINE          auto (default) | http | embedded
 *                             http     = only an external server (Ollama, LM Studio, llama-server)
 *                             embedded = only the built-in runtime (node-llama-cpp inside this process; weights from `npm run setup:local-llm`)
 *                             auto     = an external server when one is ready, otherwise the built-in runtime when its model is downloaded
 *   LOCAL_LLM_MODEL_URI / LOCAL_LLM_MODEL_PATH / LOCAL_LLM_MODELS_DIR / LOCAL_LLM_CONTEXT_SIZE   built-in runtime (see server/embeddedLlm.ts)
 *
 * Things only Gemini can do are never faked: Google Search grounding, image / audio parts, and tool calls are refused so the
 * client takes the same path it takes without a key (its own web search + the evidence it gathered).
 */

import { EmbeddedEngineError, getEmbeddedEngine, type EmbeddedStatus } from './embeddedLlm.ts';

export type LlmProviderMode = 'auto' | 'gemini' | 'local';
export type LocalEngineMode = 'auto' | 'http' | 'embedded';

export const DEFAULT_LOCAL_BASE_URL = 'http://localhost:11434';
export const DEFAULT_LOCAL_MODEL = 'gemma4:e4b';

export interface LocalLlmConfig {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxConcurrency: number;
  temperature: number;
  engine: LocalEngineMode;
}

export function getProviderMode(env: NodeJS.ProcessEnv = process.env): LlmProviderMode {
  const raw = String(env.LLM_PROVIDER || '').trim().toLowerCase();
  return raw === 'gemini' || raw === 'local' ? raw : 'auto';
}

function envNumber(value: string | undefined, fallback: number, min = 0): number {
  const parsed = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

export function readLocalLlmConfig(env: NodeJS.ProcessEnv = process.env): LocalLlmConfig {
  const baseUrl = String(env.LOCAL_LLM_BASE_URL || DEFAULT_LOCAL_BASE_URL).trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
  return {
    baseUrl,
    model: String(env.LOCAL_LLM_MODEL || DEFAULT_LOCAL_MODEL).trim(),
    timeoutMs: Math.floor(envNumber(env.LOCAL_LLM_TIMEOUT_MS, 300_000)),
    maxConcurrency: Math.max(1, Math.floor(envNumber(env.LOCAL_LLM_MAX_CONCURRENCY, 1, 1))),
    temperature: envNumber(env.LOCAL_LLM_TEMPERATURE, 0.4),
    engine: ['http', 'embedded'].includes(String(env.LOCAL_LLM_ENGINE || '').trim().toLowerCase())
      ? (String(env.LOCAL_LLM_ENGINE).trim().toLowerCase() as LocalEngineMode)
      : 'auto',
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type LocalLlmErrorReason =
  | 'local_unreachable'    // nothing answered at LOCAL_LLM_BASE_URL
  | 'local_model_missing'  // the server answered but does not have the model
  | 'local_timeout'        // no answer within LOCAL_LLM_TIMEOUT_MS
  | 'local_bad_response'   // an answer the engine cannot use (empty, not a chat completion)
  | 'local_rejected'       // the server refused the request (bad schema, out of memory, ...)
  | 'local_unsupported';   // the request needs something only Gemini offers

export class LocalLlmError extends Error {
  constructor(
    readonly reason: LocalLlmErrorReason,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'LocalLlmError';
  }
}

/**
 * Error body in the shape the client already understands. Status 424 and a message free of the words the client's retry logic
 * reacts to (429, 503, quota, unavailable, not found, ...) make it final: no retry storm, no cycling through three Gemini model
 * names, and the engine goes straight to its offline book. Specifics (URL, model, upstream text) travel in `details`.
 */
export function buildLocalErrorPayload(err: LocalLlmError) {
  return {
    status: err.reason === 'local_unsupported' ? 400 : 424,
    payload: {
      error: {
        message: err.message,
        code: err.reason === 'local_unsupported' ? 400 : 424,
        reason: err.reason,
        details: err.details,
        retriesExhausted: true,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Gemini request -> OpenAI-compatible chat request
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Gemini's schema dialect (type: "OBJECT", ...) to plain JSON Schema. Objects without `required` get every property required. */
export function geminiSchemaToJsonSchema(schema: any): any {
  if (Array.isArray(schema)) return schema.map(geminiSchemaToJsonSchema);
  if (!schema || typeof schema !== 'object') return schema;

  const out: Record<string, any> = {};
  const type = typeof schema.type === 'string' ? schema.type.toLowerCase() : undefined;
  if (type) out.type = schema.nullable ? [type, 'null'] : type;
  if (typeof schema.description === 'string') out.description = schema.description;
  if (Array.isArray(schema.enum)) out.enum = schema.enum;

  if (schema.properties && typeof schema.properties === 'object') {
    out.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [key, geminiSchemaToJsonSchema(value)])
    );
    // Gemini treats a missing `required` as "usually all of them"; a small model needs it spelled out or it drops fields.
    out.required = Array.isArray(schema.required) ? schema.required : Object.keys(schema.properties);
    out.additionalProperties = false;
  } else if (Array.isArray(schema.required)) {
    out.required = schema.required;
  }

  if (schema.items) out.items = geminiSchemaToJsonSchema(schema.items);
  for (const key of ['minItems', 'maxItems', 'minimum', 'maximum'] as const) {
    const value = Number(schema[key]);
    if (schema[key] !== undefined && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

function partsToText(parts: any): string {
  const list = Array.isArray(parts) ? parts : [parts];
  const texts: string[] = [];
  for (const part of list) {
    if (typeof part === 'string') {
      texts.push(part);
    } else if (part && typeof part.text === 'string') {
      texts.push(part.text);
    } else if (part && (part.inlineData || part.fileData || part.functionCall || part.functionResponse || part.executableCode)) {
      throw new LocalLlmError('local_unsupported', 'The local model only handles text; this request carries images, audio or tool calls.');
    }
  }
  return texts.join('\n');
}

function contentToMessage(content: any): ChatMessage | null {
  if (typeof content === 'string') return { role: 'user', content };
  if (!content || typeof content !== 'object') return null;
  if (content.parts !== undefined) {
    const role = content.role === 'model' || content.role === 'assistant' ? 'assistant' : 'user';
    return { role, content: partsToText(content.parts) };
  }
  if (typeof content.text === 'string') return { role: 'user', content: content.text };
  return null;
}

export function contentsToMessages(contents: any, systemInstruction?: any): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (systemInstruction !== undefined && systemInstruction !== null) {
    const system = typeof systemInstruction === 'string' ? systemInstruction : partsToText(systemInstruction.parts ?? systemInstruction);
    if (system.trim()) messages.push({ role: 'system', content: system });
  }
  const list = Array.isArray(contents) ? contents : [contents];
  for (const item of list) {
    const message = contentToMessage(item);
    if (message && message.content.trim()) messages.push(message);
  }
  if (!messages.some((message) => message.role !== 'system')) {
    throw new LocalLlmError('local_unsupported', 'The request has no text for the local model to answer.');
  }
  return messages;
}

/** Whether a Gemini-shaped request is something a text-only local model can answer. */
export function isLocalCompatible(body: { contents?: any; config?: any }): { ok: boolean; why?: 'grounding' | 'unsupported' } {
  const config = body?.config || {};
  const tools = Array.isArray(config.tools) ? config.tools : [];
  if (tools.some((tool: any) => tool && (tool.googleSearch || tool.googleSearchRetrieval))) return { ok: false, why: 'grounding' };
  if (tools.length > 0 || config.toolConfig || config.responseModalities || config.speechConfig) return { ok: false, why: 'unsupported' };
  try {
    contentsToMessages(body?.contents, config.systemInstruction);
  } catch {
    return { ok: false, why: 'unsupported' };
  }
  return { ok: true };
}

export function wantsJson(config: any): boolean {
  return Boolean(config?.responseSchema) || String(config?.responseMimeType || '').toLowerCase() === 'application/json';
}

export function buildChatRequest(body: { contents?: any; config?: any }, model: string, cfg: Pick<LocalLlmConfig, 'temperature'>) {
  const config = body.config || {};
  const request: Record<string, any> = {
    model,
    messages: contentsToMessages(body.contents, config.systemInstruction),
    stream: false,
    temperature: Number.isFinite(Number(config.temperature)) && config.temperature !== undefined ? Number(config.temperature) : cfg.temperature,
  };
  if (Number.isFinite(Number(config.topP)) && config.topP !== undefined) request.top_p = Number(config.topP);
  if (Number.isFinite(Number(config.maxOutputTokens)) && config.maxOutputTokens !== undefined) request.max_tokens = Number(config.maxOutputTokens);
  if (Number.isFinite(Number(config.seed)) && config.seed !== undefined) request.seed = Number(config.seed);
  if (Array.isArray(config.stopSequences) && config.stopSequences.length > 0) request.stop = config.stopSequences;

  if (wantsJson(config)) {
    request.response_format = config.responseSchema
      ? { type: 'json_schema', json_schema: { name: 'response', strict: true, schema: geminiSchemaToJsonSchema(config.responseSchema) } }
      : { type: 'json_object' };
  }
  return request;
}

// ---------------------------------------------------------------------------
// OpenAI-compatible chat response -> Gemini response
// ---------------------------------------------------------------------------

export function stripCodeFence(text: string): string {
  const match = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1] : text;
}

export interface LocalGenerateResult {
  text: string;
  candidates: Array<{ content: { role: 'model'; parts: Array<{ text: string }> }; finishReason: string; index: number }>;
  usageMetadata: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
  modelUsed: string;
  provider: 'local';
}

export function mapChatResponse(data: any, expectJson: boolean, modelUsed: string): LocalGenerateResult {
  const choice = data?.choices?.[0];
  let text = choice?.message?.content;
  if (Array.isArray(text)) text = text.map((part: any) => (typeof part === 'string' ? part : part?.text || '')).join('');
  if (typeof text !== 'string' || !text.trim()) {
    throw new LocalLlmError('local_bad_response', 'The local model returned no text.', { finishReason: choice?.finish_reason ?? null });
  }
  if (expectJson) text = stripCodeFence(text);

  const finish = String(choice?.finish_reason || '').toLowerCase();
  const usage = data?.usage || {};
  return {
    text,
    candidates: [
      {
        content: { role: 'model', parts: [{ text }] },
        finishReason: finish === 'length' ? 'MAX_TOKENS' : finish === 'stop' || finish === '' ? 'STOP' : 'OTHER',
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: usage.prompt_tokens,
      candidatesTokenCount: usage.completion_tokens,
      totalTokenCount: usage.total_tokens,
    },
    modelUsed: `${modelUsed} (local)`,
    provider: 'local',
  };
}

// ---------------------------------------------------------------------------
// Talking to the local server
// ---------------------------------------------------------------------------

class Semaphore {
  private active = 0;
  private waiters: Array<() => void> = [];

  async run<T>(limit: number, task: () => Promise<T>): Promise<T> {
    if (this.active >= limit) {
      // The finishing task hands its slot straight to us: `active` is not touched, so a request arriving in between
      // cannot slip into the gap and run beside us.
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    } else {
      this.active += 1;
    }
    try {
      return await task();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active -= 1;
    }
  }
}

const gate = new Semaphore();

const normalizeModelName = (name: string) => name.trim().toLowerCase().replace(/:latest$/, '');

export interface LocalLlmStatus {
  /** An external OpenAI-compatible server answered. */
  reachable: boolean;
  /** Models the external server lists. */
  models: string[];
  /** The model that will answer: the configured one, the only model a single-model server has loaded, or the built-in model. */
  model: string;
  modelInstalled: boolean;
  /** Something local can answer right now: safe for auto mode to route a request here. */
  ready: boolean;
  baseUrl: string;
  /** Which engine will answer: an external server, the built-in runtime, or none. */
  engine: 'http' | 'embedded' | 'none';
  /** State of the built-in runtime (absent when LOCAL_LLM_ENGINE=http). */
  embedded?: EmbeddedStatus;
}

let statusCache: { at: number; key: string; status: LocalLlmStatus } | null = null;
const STATUS_TTL_MS = 10_000;

export function resetLocalLlmCache(): void {
  statusCache = null;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function probeHttpServer(cfg: LocalLlmConfig): Promise<{ reachable: boolean; models: string[]; model: string; installed: boolean }> {
  const down = { reachable: false, models: [] as string[], model: cfg.model, installed: false };
  try {
    const response = await fetchWithTimeout(`${cfg.baseUrl}/v1/models`, { headers: { accept: 'application/json' } }, 1500);
    if (!response.ok) return down;
    const data: any = await response.json().catch(() => ({}));
    const models: string[] = (Array.isArray(data?.data) ? data.data : []).map((entry: any) => String(entry?.id || '')).filter(Boolean);
    const wanted = normalizeModelName(cfg.model);
    const exact = models.find((name) => normalizeModelName(name) === wanted);
    return { reachable: true, models, model: exact ?? (models.length === 1 ? models[0] : cfg.model), installed: Boolean(exact) || models.length === 1 };
  } catch {
    return down; // not running
  }
}

/**
 * What can answer locally right now. An external server is probed with GET {base}/v1/models; the built-in runtime is asked
 * whether it loads and whether its model file is on disk. Cached for a few seconds, so an absent server costs one fast probe.
 * In auto mode an external server wins when it is ready (it is the one the user chose to run), else the built-in runtime.
 */
export async function getLocalLlmStatus(env: NodeJS.ProcessEnv = process.env, options: { fresh?: boolean } = {}): Promise<LocalLlmStatus> {
  const cfg = readLocalLlmConfig(env);
  const key = [cfg.engine, cfg.baseUrl, cfg.model, env.LOCAL_LLM_MODEL_PATH, env.LOCAL_LLM_MODEL_URI, env.LOCAL_LLM_MODELS_DIR].join('|');
  if (!options.fresh && statusCache && statusCache.key === key && Date.now() - statusCache.at < STATUS_TTL_MS) return statusCache.status;

  const http = cfg.engine === 'embedded' ? undefined : await probeHttpServer(cfg);
  let embedded: EmbeddedStatus | undefined;
  if (cfg.engine !== 'http') {
    embedded = await getEmbeddedEngine(env).status().catch((err: any) => ({
      available: false, modelPresent: false, modelName: '', modelUri: '', reason: String(err?.message || err).slice(0, 160),
    }));
  }

  const httpReady = Boolean(http?.reachable && http.installed);
  const embeddedReady = Boolean(embedded?.available && embedded.modelPresent);
  const engine: LocalLlmStatus['engine'] =
    cfg.engine === 'http' ? (httpReady ? 'http' : 'none')
    : cfg.engine === 'embedded' ? (embeddedReady ? 'embedded' : 'none')
    : httpReady ? 'http' : embeddedReady ? 'embedded' : 'none';

  const status: LocalLlmStatus = {
    reachable: http?.reachable ?? false,
    models: http?.models ?? [],
    model: engine === 'embedded' && embedded ? embedded.modelName : http?.model ?? cfg.model,
    modelInstalled: engine === 'embedded' ? true : http?.installed ?? false,
    ready: engine !== 'none',
    baseUrl: cfg.baseUrl,
    engine,
    embedded,
  };
  statusCache = { at: Date.now(), key, status };
  return status;
}

function toLocalError(err: unknown): LocalLlmError {
  if (err instanceof LocalLlmError) return err;
  if (err instanceof EmbeddedEngineError) {
    switch (err.reason) {
      case 'aborted':
        return new LocalLlmError('local_timeout', 'The local model took too long to answer (the limit is LOCAL_LLM_TIMEOUT_MS). Try a smaller model.', err.details);
      case 'model_missing':
        return new LocalLlmError('local_model_missing', err.message, err.details);
      case 'unavailable':
        return new LocalLlmError('local_unreachable', err.message, err.details);
      default:
        return new LocalLlmError('local_rejected', err.message, err.details);
    }
  }
  return new LocalLlmError('local_rejected', 'The local model failed unexpectedly.', { upstreamMessage: String((err as any)?.message || err).slice(0, 300) });
}

/** Writes with the built-in runtime. Same gate, same schema translation, same time limit as the external-server path. */
async function callEmbedded(body: { contents?: any; config?: any }, cfg: LocalLlmConfig, status: LocalLlmStatus, env: NodeJS.ProcessEnv): Promise<LocalGenerateResult> {
  const request = buildChatRequest(body, status.model, cfg);
  const engine = getEmbeddedEngine(env);
  return gate.run(cfg.maxConcurrency, async () => {
    const controller = new AbortController();
    const timer = cfg.timeoutMs > 0 ? setTimeout(() => controller.abort(), cfg.timeoutMs) : undefined;
    try {
      const out = await engine.complete({
        messages: request.messages,
        temperature: request.temperature,
        maxTokens: request.max_tokens,
        topP: request.top_p,
        seed: request.seed,
        stop: request.stop,
        jsonSchema: request.response_format?.json_schema?.schema,
        jsonObject: request.response_format?.type === 'json_object',
        signal: controller.signal,
      });
      return mapChatResponse(
        {
          choices: [{ message: { content: out.text }, finish_reason: out.finishReason }],
          usage: { prompt_tokens: out.promptTokens, completion_tokens: out.completionTokens, total_tokens: (out.promptTokens ?? 0) + (out.completionTokens ?? 0) },
        },
        wantsJson(body.config),
        out.modelName
      );
    } catch (err) {
      resetLocalLlmCache();
      throw toLocalError(err);
    } finally {
      if (timer) clearTimeout(timer);
    }
  });
}

/** Answers one Gemini-shaped request with the local model. Throws LocalLlmError (never anything else). */
export async function callLocalLlm(body: { model?: string; contents?: any; config?: any }, env: NodeJS.ProcessEnv = process.env): Promise<LocalGenerateResult> {
  const cfg = readLocalLlmConfig(env);

  const compat = isLocalCompatible(body);
  if (!compat.ok) {
    throw new LocalLlmError(
      'local_unsupported',
      compat.why === 'grounding'
        ? 'Google Search grounding needs a Gemini API key; a local model cannot search the web.'
        : 'The local model only handles text; this request carries images, audio or tool calls.'
    );
  }

  const requested = body.model && !/^gemini/i.test(body.model) ? body.model : cfg.model;
  const status = await getLocalLlmStatus(env);

  if (status.engine === 'embedded') return callEmbedded(body, cfg, status, env);

  if (!status.reachable) {
    // Nothing external is running: say what could answer instead of only "not reachable".
    const embedded = status.embedded;
    if (cfg.engine === 'embedded' || (cfg.engine === 'auto' && embedded)) {
      if (embedded && !embedded.available) {
        throw new LocalLlmError('local_unreachable', 'The built-in local model runtime cannot be used on this machine. Start Ollama or LM Studio instead (and set LOCAL_LLM_ENGINE=http).', { embedded: embedded.reason, baseUrl: cfg.baseUrl });
      }
      if (embedded && !embedded.modelPresent) {
        throw new LocalLlmError(
          cfg.engine === 'embedded' ? 'local_model_missing' : 'local_unreachable',
          cfg.engine === 'embedded'
            ? 'The local model file has not been downloaded yet. Run: npm run setup:local-llm'
            : 'No local model is running. Start Ollama or LM Studio, or download the built-in model with: npm run setup:local-llm',
          { modelUri: embedded.modelUri, baseUrl: cfg.baseUrl }
        );
      }
    }
    throw new LocalLlmError('local_unreachable', 'The local model server did not answer. Make sure it is running and that LOCAL_LLM_BASE_URL points to it.', { baseUrl: cfg.baseUrl });
  }
  const wanted = normalizeModelName(requested);
  const model = status.models.find((name) => normalizeModelName(name) === wanted) ?? (status.models.length === 1 ? status.models[0] : requested);

  const request = buildChatRequest(body, model, cfg);

  return gate.run(cfg.maxConcurrency, async () => {
    let response: Response;
    try {
      response = await fetchWithTimeout(
        `${cfg.baseUrl}/v1/chat/completions`,
        { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(request) },
        cfg.timeoutMs
      );
    } catch (err: any) {
      resetLocalLlmCache();
      if (err?.name === 'AbortError') {
        throw new LocalLlmError('local_timeout', 'The local model took too long to answer (the limit is LOCAL_LLM_TIMEOUT_MS). Try a smaller model.', { timeoutMs: cfg.timeoutMs, model });
      }
      throw new LocalLlmError('local_unreachable', 'The local model server did not answer. Make sure it is running and that LOCAL_LLM_BASE_URL points to it.', { baseUrl: cfg.baseUrl });
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let upstream = text.slice(0, 500);
      try {
        const parsed = JSON.parse(text);
        upstream = String(parsed?.error?.message ?? parsed?.error ?? upstream).slice(0, 500);
      } catch { /* keep the raw text */ }
      resetLocalLlmCache();
      if (response.status === 404) {
        throw new LocalLlmError('local_model_missing', 'The local model is not installed on the local server. Pull it first (for Ollama: ollama pull <model>) or set LOCAL_LLM_MODEL to an installed model.', { model, upstreamStatus: response.status, upstreamMessage: upstream });
      }
      throw new LocalLlmError('local_rejected', 'The local model server rejected the request.', { model, upstreamStatus: response.status, upstreamMessage: upstream });
    }

    let data: any;
    try {
      data = await response.json();
    } catch {
      throw new LocalLlmError('local_bad_response', 'The local model server sent an answer that is not valid JSON.', { model });
    }
    return mapChatResponse(data, wantsJson(body.config), model);
  });
}

// ---------------------------------------------------------------------------
// Choosing a provider for one request
// ---------------------------------------------------------------------------

export type GeneratePlan =
  | { route: 'gemini' }                       // Google only (the caller reports a missing key itself)
  | { route: 'local' }                        // the local model only
  | { route: 'gemini-then-local' }            // Google first; a persistent Google failure falls over to a ready local model
  | { route: 'blocked'; kind: 'grounding' | 'unsupported' }; // LLM_PROVIDER=local and the request needs Google

/**
 *  gemini mode: always Google.
 *  local mode : always the local model; requests only Gemini can serve are blocked (the client then does what it does without a key).
 *  auto mode  : no key -> a ready local model, else Google's missing-key answer (so the engine writes its extractive offline book);
 *               a key -> Google first, with the local model as the fallback for key / quota / outage failures.
 *               Requests only Gemini can serve (search grounding) always go to Google.
 */
export async function planGeneration(body: { contents?: any; config?: any }, hasKey: boolean, env: NodeJS.ProcessEnv = process.env): Promise<GeneratePlan> {
  const mode = getProviderMode(env);
  if (mode === 'gemini') return { route: 'gemini' };

  const compat = isLocalCompatible(body);
  if (mode === 'local') return compat.ok ? { route: 'local' } : { route: 'blocked', kind: compat.why ?? 'unsupported' };
  if (!compat.ok) return { route: 'gemini' };

  if (!hasKey) return (await getLocalLlmStatus(env)).ready ? { route: 'local' } : { route: 'gemini' };
  return { route: 'gemini-then-local' };
}

/** A bad request is ours to fix and a local model will not do better; every other Google failure may be answered locally. */
export function shouldFailOverToLocal(googleErrorReason: string | undefined): boolean {
  return googleErrorReason !== 'bad_request';
}
