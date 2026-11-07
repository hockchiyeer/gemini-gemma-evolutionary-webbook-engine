import type { IncomingMessage, ServerResponse } from "node:http";
import type { Server as HttpServer } from "node:http";
import type { Plugin } from "vite";
import { GoogleGenAI, Modality } from "@google/genai";
import type { LiveServerMessage } from "@google/genai";
import { WebSocketServer, WebSocket } from "ws";
import dotenv from "dotenv";
import { GEMINI_MODELS } from "../src/types.ts";
import { classifyGeminiError, computeBackoffMs, type ClassifiedGeminiError } from "./geminiErrors.ts";
import {
  LocalLlmError,
  buildLocalErrorPayload,
  callLocalLlm,
  getLocalLlmStatus,
  getProviderMode,
  planGeneration,
  readLocalLlmConfig,
  shouldFailOverToLocal,
  type LocalGenerateResult,
} from "./localLlm.ts";

dotenv.config();

const DEFAULT_MODEL = "gemini-3.6-flash";

function envInt(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

// Tunables (set in .env). Defaults are conservative so a free-tier project is not flooded.
//   GEMINI_MAX_CONCURRENCY   simultaneous requests to Google from this server (default 3)
//   GEMINI_MAX_ATTEMPTS      tries per request for rate-limit / overload / transient errors (default 4)
//   GEMINI_MAX_RETRY_WAIT_MS longest single wait we are willing to sit through before giving up (default 45000)
//   GEMINI_REQUEST_TIMEOUT_MS longest we wait for ONE answer from Google (default 50000, 0 = no limit). Kept under the ~60 s
//                            at which hosting gateways cut a request, so a slow model fails over instead of hanging.
const maxConcurrency = () => Math.max(1, envInt("GEMINI_MAX_CONCURRENCY", 3));
const maxAttempts = () => Math.max(1, envInt("GEMINI_MAX_ATTEMPTS", 4));
const maxRetryWaitMs = () => Math.max(1000, envInt("GEMINI_MAX_RETRY_WAIT_MS", 45_000));
const requestTimeoutMs = () => envInt("GEMINI_REQUEST_TIMEOUT_MS", 50_000);

// The client is created lazily and re-created if the key changes, so a key edited in .env / secrets
// after the server started is picked up instead of every request failing with the stale one.
let cachedClient: { key: string; client: GoogleGenAI } | null = null;

export function getAi(): GoogleGenAI {
  const key = process.env.GEMINI_API_KEY || "";
  if (!cachedClient || cachedClient.key !== key) {
    cachedClient = {
      key,
      client: new GoogleGenAI({
        apiKey: key || undefined,
        httpOptions: {
          headers: {
            "User-Agent": "aistudio-build",
          },
        },
      }),
    };
  }
  return cachedClient.client;
}

// Kept for backwards compatibility with code that imported the old singleton.
export const ai: GoogleGenAI = new Proxy({} as GoogleGenAI, {
  get(_target, prop) {
    const client = getAi() as any;
    const value = client[prop];
    return typeof value === "function" ? value.bind(client) : value;
  },
});

export interface GeminiGenerateRequestBody {
  model?: string;
  contents: any;
  config?: any;
}

class Gate {
  private active = 0;
  private waiters: Array<() => void> = [];

  async run<T>(task: () => Promise<T>): Promise<T> {
    const limit = maxConcurrency();
    if (this.active >= limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

const gate = new Gate();

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class GeminiTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Gemini did not answer within ${Math.round(timeoutMs / 1000)} s (the selected model is responding too slowly).`);
    this.name = "GeminiTimeoutError";
  }
}

export class GeminiCallError extends Error {
  readonly classified: ClassifiedGeminiError;
  readonly attempts: number;

  constructor(classified: ClassifiedGeminiError, attempts: number) {
    super(classified.message);
    this.name = "GeminiCallError";
    this.classified = classified;
    this.attempts = attempts;
  }
}

/** Runs one attempt and gives up on it after `timeoutMs` (0 = no limit); the SDK request is aborted too. */
async function runWithTimeout<T>(task: (signal?: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) return task();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new GeminiTimeoutError(timeoutMs)); // first, so it wins the race against the abort error below
      controller.abort();
    }, timeoutMs);
  });
  try {
    const running = task(controller.signal);
    running.catch(() => {}); // an aborted request that fails after the timeout already won must not be an unhandled rejection
    return await Promise.race([running, timedOut]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Runs a Gemini call with a bounded number of attempts. Only errors that can clear by themselves
 * (per-minute rate limit, overload, transient 5xx, network) are retried, honouring the delay Google asks
 * for. Daily-quota, no-free-tier, auth, permission, model and bad-request errors fail immediately:
 * retrying them cannot help and only burns more quota.
 */
export async function callGemini<T>(task: (signal?: AbortSignal) => Promise<T>): Promise<T> {
  const attempts = maxAttempts();
  const waitCap = maxRetryWaitMs();

  return gate.run(async () => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await runWithTimeout(task, requestTimeoutMs());
      } catch (err) {
        const classified = classifyGeminiError(err);
        const delay = classified.retryAfterMs ?? computeBackoffMs(attempt);
        const giveUp = !classified.retryable || attempt >= attempts || delay > waitCap;
        if (giveUp) {
          throw new GeminiCallError(classified, attempt);
        }
        console.warn(
          `[gemini] ${classified.reason} (HTTP ${classified.httpStatus}); retry ${attempt}/${attempts - 1} in ${Math.round(delay / 1000)}s`
        );
        await sleep(delay);
      }
    }
  });
}

async function readJsonBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown, headers: Record<string, string> = {}): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.end(JSON.stringify(payload));
}

function buildErrorPayload(classified: ClassifiedGeminiError, attempts = 1) {
  return {
    error: {
      message: classified.message,
      code: classified.httpStatus,
      status: classified.httpStatus === 429 ? "RESOURCE_EXHAUSTED" : undefined,
      // Machine-readable cause, so the UI can say what really happened instead of guessing from text.
      reason: classified.reason,
      retryAfterSeconds: classified.retryAfterMs != null ? Math.ceil(classified.retryAfterMs / 1000) : undefined,
      // True when the server already retried this request, so the client must not retry it again.
      retriesExhausted: (classified.retryable && attempts > 1) || classified.reason === "timeout",
    },
  };
}

function sendGeminiError(res: ServerResponse, err: unknown): void {
  const classified = err instanceof GeminiCallError ? err.classified : classifyGeminiError(err);
  const attempts = err instanceof GeminiCallError ? err.attempts : 1;
  const headers: Record<string, string> = {};
  if (classified.retryAfterMs != null) headers["Retry-After"] = String(Math.ceil(classified.retryAfterMs / 1000));
  sendJson(res, classified.httpStatus || 500, buildErrorPayload(classified, attempts), headers);
}

function missingKeyPayload() {
  return {
    error: {
      message: "Missing Gemini API key on server. Set GEMINI_API_KEY in environment secrets.",
      status: "UNAUTHENTICATED",
      code: 401,
      reason: "missing_api_key",
    },
  };
}

/** A local answer in the response shape the client already reads, plus which model really wrote it. */
function localResponsePayload(result: LocalGenerateResult) {
  return {
    text: result.text,
    candidates: result.candidates,
    usageMetadata: result.usageMetadata,
    modelUsed: result.modelUsed,
    provider: result.provider,
  };
}

function sendLocalError(res: ServerResponse, err: unknown): void {
  const localError = err instanceof LocalLlmError ? err : new LocalLlmError("local_bad_response", "The local model failed unexpectedly.");
  const { status, payload } = buildLocalErrorPayload(localError);
  console.warn(`[local-llm] ${localError.reason}`, localError.details);
  sendJson(res, status, payload);
}

/** What the client sees when LLM_PROVIDER=local and a request needs Google: exactly the no-key answer, so it takes its no-key path. */
function sendBlockedForLocal(res: ServerResponse, kind: "grounding" | "unsupported"): void {
  if (kind === "grounding") {
    sendJson(res, 401, missingKeyPayload());
    return;
  }
  sendLocalError(res, new LocalLlmError("local_unsupported", "The local model only handles text; this request carries images, audio or tool calls."));
}

export async function handleGeminiGenerate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: { message: "Method not allowed" } });
    return;
  }

  try {
    const body: GeminiGenerateRequestBody = await readJsonBody(req);
    const model = body.model || DEFAULT_MODEL;
    const hasKey = Boolean(process.env.GEMINI_API_KEY);
    const plan = await planGeneration(body, hasKey);

    if (plan.route === "blocked") {
      sendBlockedForLocal(res, plan.kind);
      return;
    }

    if (plan.route === "local") {
      try {
        sendJson(res, 200, localResponsePayload(await callLocalLlm(body)));
      } catch (err) {
        sendLocalError(res, err);
      }
      return;
    }

    if (!hasKey) {
      sendJson(res, 401, missingKeyPayload());
      return;
    }

    try {
      const response = await callGemini((signal) =>
        getAi().models.generateContent({
          model,
          contents: body.contents,
          config: { ...body.config, abortSignal: signal },
        })
      );

      sendJson(res, 200, {
        text: response.text,
        candidates: response.candidates,
        usageMetadata: response.usageMetadata,
      });
    } catch (err: any) {
      const classified = err instanceof GeminiCallError ? err.classified : classifyGeminiError(err);
      if (plan.route === "gemini-then-local" && shouldFailOverToLocal(classified.reason) && (await getLocalLlmStatus()).ready) {
        console.warn(`[gemini] ${classified.reason}; answering with the local model instead`);
        try {
          sendJson(res, 200, localResponsePayload(await callLocalLlm(body)));
          return;
        } catch {
          // The local model failed too: report Google's error, which is the one the user can act on.
        }
      }
      sendGeminiError(res, err);
    }
  } catch (err: any) {
    sendGeminiError(res, err);
  }
}

export async function handleGeminiStream(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: { message: "Method not allowed" } });
    return;
  }

  // A local answer arrives whole; it is sent as a single event so a client that reads the stream works unchanged.
  const sendLocalStream = (result: LocalGenerateResult) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify(localResponsePayload(result))}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  };

  try {
    const body: GeminiGenerateRequestBody = await readJsonBody(req);
    const model = body.model || DEFAULT_MODEL;
    const hasKey = Boolean(process.env.GEMINI_API_KEY);
    const plan = await planGeneration(body, hasKey);

    if (plan.route === "blocked") {
      sendBlockedForLocal(res, plan.kind);
      return;
    }

    if (plan.route === "local") {
      try {
        sendLocalStream(await callLocalLlm(body));
      } catch (err) {
        sendLocalError(res, err);
      }
      return;
    }

    if (!hasKey) {
      sendJson(res, 401, missingKeyPayload());
      return;
    }

    // Errors Google reports when the stream is opened (rate limit, bad key, ...) surface here, before any
    // byte is sent to the browser, so they can still be retried and returned with their real HTTP status.
    let responseStream: Awaited<ReturnType<ReturnType<typeof getAi>["models"]["generateContentStream"]>>;
    try {
      responseStream = await callGemini((signal) =>
        getAi().models.generateContentStream({
          model,
          contents: body.contents,
          config: { ...body.config, abortSignal: signal },
        })
      );
    } catch (err: any) {
      const classified = err instanceof GeminiCallError ? err.classified : classifyGeminiError(err);
      if (plan.route === "gemini-then-local" && shouldFailOverToLocal(classified.reason) && (await getLocalLlmStatus()).ready) {
        console.warn(`[gemini] ${classified.reason}; answering with the local model instead`);
        try {
          sendLocalStream(await callLocalLlm(body));
          return;
        } catch {
          // The local model failed too: report Google's error.
        }
      }
      throw err;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });

    for await (const chunk of responseStream) {
      const payload = JSON.stringify({
        text: chunk.text,
        candidates: chunk.candidates,
        usageMetadata: chunk.usageMetadata,
      });
      res.write(`data: ${payload}\n\n`);
    }

    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err: any) {
    if (!res.headersSent) {
      sendGeminiError(res, err);
    } else {
      const classified = err instanceof GeminiCallError ? err.classified : classifyGeminiError(err);
      res.write(`data: ${JSON.stringify(buildErrorPayload(classified))}\n\n`);
      res.end();
    }
  }
}

/**
 * GET /api/local-llm/health
 * Whether a local model server is running, which models it has, and whether the configured one will answer. Never calls Google.
 */
export async function handleLocalLlmHealth(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cfg = readLocalLlmConfig();
  const status = await getLocalLlmStatus(process.env, { fresh: true });
  sendJson(res, 200, {
    provider: getProviderMode(),
    baseUrl: cfg.baseUrl,
    configuredModel: cfg.model,
    reachable: status.reachable,
    models: status.models,
    modelInstalled: status.modelInstalled,
    modelInUse: status.model,
    ready: status.ready,
    geminiKeyPresent: Boolean(process.env.GEMINI_API_KEY),
    hint: !status.reachable
      ? "No local model server answered. Install Ollama, run it, then: ollama pull " + cfg.model
      : !status.modelInstalled
        ? "The server is running but does not have " + cfg.model + ". Run: ollama pull " + cfg.model + " (or set LOCAL_LLM_MODEL to one of: " + (status.models.join(", ") || "none installed") + ")"
        : undefined,
  });
}

/**
 * GET /api/gemini/health[?model=...]
 * Makes one tiny real request and reports exactly what Google answered. This is the fastest way to tell
 * "quota", "bad key", "model not available to this project", "blocked" and "no network" apart.
 * The key itself is never returned.
 */
export async function handleGeminiHealth(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || "/", "http://localhost");
  const model = url.searchParams.get("model") || DEFAULT_MODEL;
  const key = process.env.GEMINI_API_KEY || "";
  const base = {
    model,
    keyPresent: Boolean(key),
    keyLooksValid: /^AIza[0-9A-Za-z_-]{30,}$/.test(key),
    keyLength: key.length,
  };

  if (!key) {
    sendJson(res, 200, { ok: false, ...base, reason: "missing_api_key", httpStatus: 401, message: missingKeyPayload().error.message });
    return;
  }

  const startedAt = Date.now();
  try {
    const response = await getAi().models.generateContent({
      model,
      contents: "Reply with the single word: OK",
      config: { maxOutputTokens: 256 },
    });
    sendJson(res, 200, {
      ok: true,
      ...base,
      httpStatus: 200,
      latencyMs: Date.now() - startedAt,
      sample: String(response.text ?? "").slice(0, 40),
    });
  } catch (err: any) {
    const classified = classifyGeminiError(err);
    sendJson(res, 200, {
      ok: false,
      ...base,
      httpStatus: classified.httpStatus,
      reason: classified.reason,
      retryAfterSeconds: classified.retryAfterMs != null ? Math.ceil(classified.retryAfterMs / 1000) : undefined,
      message: classified.message.slice(0, 600),
      latencyMs: Date.now() - startedAt,
    });
  }
}

let cachedModelList: { at: number; key: string; models: string[] } | null = null;

async function listAvailableModels(): Promise<{ models: string[]; source: "live" | "static" }> {
  const staticModels = [...GEMINI_MODELS] as string[];
  const key = process.env.GEMINI_API_KEY || "";
  if (!key) return { models: staticModels, source: "static" };

  if (cachedModelList && cachedModelList.key === key && Date.now() - cachedModelList.at < 10 * 60_000) {
    return { models: cachedModelList.models, source: "live" };
  }

  try {
    const names: string[] = [];
    const pager: any = await getAi().models.list({ config: { pageSize: 100 } });
    for await (const model of pager) {
      const name = String(model?.name || "").replace(/^models\//, "");
      const actions: string[] = Array.isArray(model?.supportedActions) ? model.supportedActions : [];
      if (name.startsWith("gemini") && (actions.length === 0 || actions.includes("generateContent"))) {
        names.push(name);
      }
    }
    if (names.length > 0) {
      cachedModelList = { at: Date.now(), key, models: names };
      return { models: names, source: "live" };
    }
  } catch (err) {
    console.warn("[gemini] model discovery failed; using the built-in list", classifyGeminiError(err).reason);
  }
  return { models: staticModels, source: "static" };
}

export function createGeminiMiddleware() {
  return async (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => {
    if (!req.url) {
      next();
      return;
    }

    const url = new URL(req.url, "http://localhost");
    const { pathname } = url;

    if (pathname === "/api/gemini/generate") {
      await handleGeminiGenerate(req, res);
      return;
    }

    if (pathname === "/api/gemini/stream") {
      await handleGeminiStream(req, res);
      return;
    }

    if (pathname === "/api/gemini/health" && req.method === "GET") {
      await handleGeminiHealth(req, res);
      return;
    }

    if (pathname === "/api/gemini/models" && req.method === "GET") {
      const listed = await listAvailableModels();
      const local = getProviderMode() === "gemini" ? null : await getLocalLlmStatus();
      sendJson(res, 200, local?.reachable ? { ...listed, localModels: local.models, localReady: local.ready } : listed);
      return;
    }

    if (pathname === "/api/local-llm/health" && req.method === "GET") {
      await handleLocalLlmHealth(req, res);
      return;
    }

    next();
  };
}

export function geminiPlugin(): Plugin {
  return {
    name: "gemini-api-middleware",
    configureServer(server) {
      server.middlewares.use(createGeminiMiddleware());
    },
    configurePreviewServer(server) {
      server.middlewares.use(createGeminiMiddleware());
    },
  };
}

export function setupGeminiLiveWebSocket(server: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    if (req.url === "/api/gemini/live") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    }
  });

  wss.on("connection", (clientWs: WebSocket) => {
    let session: any = null;

    const initSession = async () => {
      if (!process.env.GEMINI_API_KEY) {
        clientWs.send(
          JSON.stringify({
            error: { message: "Missing GEMINI_API_KEY on server." },
          })
        );
        clientWs.close();
        return;
      }

      session = await (getAi().live as any).connect({
        model: "gemini-3.8-live",
        config: {
          responseModalities: [Modality.AUDIO],
        },
      });

      session.on("content", (data: LiveServerMessage) => {
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify(data));
        }
      });

      session.on("close", () => {
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.close();
        }
      });

      session.on("error", (err: unknown) => {
        if (clientWs.readyState === WebSocket.OPEN) {
          const classified = classifyGeminiError(err);
          clientWs.send(JSON.stringify(buildErrorPayload(classified)));
        }
      });
    };

    initSession().catch((err) => {
      const classified = classifyGeminiError(err);
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify(buildErrorPayload(classified)));
        clientWs.close();
      }
    });

    clientWs.on("message", (data: WebSocket.RawData) => {
      if (!session) return;
      try {
        const message = JSON.parse(data.toString());
        session.send(message);
      } catch (err) {
        console.error("Failed to parse client message for Gemini Live:", err);
      }
    });

    clientWs.on("close", () => {
      if (session) {
        try {
          session.close();
        } catch {}
      }
    });
  });

  return wss;
}
