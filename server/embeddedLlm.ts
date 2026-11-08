/**
 * Built-in local model engine: llama.cpp running inside this Node process through the `node-llama-cpp` npm package.
 *
 * `npm install` brings the runtime (prebuilt binaries for Windows, macOS incl. Apple Silicon, Linux) and scripts/setup-local-llm.mjs
 * fetches the Gemma weights once; after that books can be written with no Ollama, no daemon and no Google key.
 *
 * Nothing here pretends: when the runtime or the model file is missing, `status()` says so and the provider layer reports it.
 * `node-llama-cpp` is an optional dependency, so it is loaded through a variable specifier (never bundled, never required to compile).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatMessage } from './localLlm.ts';
import { DEFAULT_LOCAL_CONTEXT_SIZE, DEFAULT_LOCAL_MODEL_URI } from './localModelDefaults.mjs';

export interface EmbeddedConfig {
  /** Explicit .gguf file; wins over the URI. */
  modelPath: string;
  modelUri: string;
  modelsDir: string;
  contextSize: number;
}

export function readEmbeddedConfig(env: NodeJS.ProcessEnv = process.env): EmbeddedConfig {
  const size = Number(env.LOCAL_LLM_CONTEXT_SIZE);
  return {
    modelPath: String(env.LOCAL_LLM_MODEL_PATH || '').trim(),
    modelUri: String(env.LOCAL_LLM_MODEL_URI || DEFAULT_LOCAL_MODEL_URI).trim(),
    modelsDir: path.resolve(String(env.LOCAL_LLM_MODELS_DIR || '').trim() || path.join(process.cwd(), 'models')),
    contextSize: Number.isFinite(size) && size >= 2048 ? Math.floor(size) : DEFAULT_LOCAL_CONTEXT_SIZE,
  };
}

export type EmbeddedFailure = 'unavailable' | 'model_missing' | 'prompt_too_long' | 'aborted' | 'failed';

export class EmbeddedEngineError extends Error {
  constructor(
    readonly reason: EmbeddedFailure,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'EmbeddedEngineError';
  }
}

export interface EmbeddedStatus {
  /** The runtime is installed and works on this machine. */
  available: boolean;
  /** Why it is not available (shown to the user). */
  reason?: string;
  /** The model file is on disk. */
  modelPresent: boolean;
  modelName: string;
  modelUri: string;
  /** "cpu", or the GPU backend in use (metal, cuda, vulkan). */
  backend?: string;
}

export interface EmbeddedRequest {
  messages: ChatMessage[];
  temperature: number;
  maxTokens?: number;
  topP?: number;
  seed?: number;
  stop?: string[];
  /** JSON Schema the output must follow (enforced by a grammar: the text is always valid against it, unless cut off by maxTokens). */
  jsonSchema?: unknown;
  /** Any valid JSON. */
  jsonObject?: boolean;
  signal?: AbortSignal;
}

export interface EmbeddedResult {
  text: string;
  finishReason: 'stop' | 'length';
  promptTokens?: number;
  completionTokens?: number;
  modelName: string;
}

export interface EmbeddedEngine {
  status(): Promise<EmbeddedStatus>;
  complete(request: EmbeddedRequest): Promise<EmbeddedResult>;
  dispose(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Locating the model file
// ---------------------------------------------------------------------------

const RUNTIME_PACKAGE = 'node-llama-cpp';
let runtimeModule: Promise<any> | null = null;

/** Loads node-llama-cpp (cached once it works; a missing package is retried, so installing it needs no restart of this check). */
export function loadNodeLlamaCpp(): Promise<any> {
  if (!runtimeModule) {
    const pending = import(/* @vite-ignore */ RUNTIME_PACKAGE);
    runtimeModule = pending;
    pending.catch(() => { if (runtimeModule === pending) runtimeModule = null; });
  }
  return runtimeModule;
}

/** "gemma-4-E2B-it-Q4_0" from ".../hf_ggml-org_gemma-4-E2B-it-Q4_0.gguf" (the hf_<user>_ prefix is how downloads are stored). */
export function modelLabel(filePath: string, modelUri = ''): string {
  let name = path.basename(filePath).replace(/\.gguf$/i, '');
  const user = modelUri.match(/^hf:([^/:]+)\//)?.[1];
  if (user && name.startsWith(`hf_${user}_`)) name = name.slice(`hf_${user}_`.length);
  return name;
}

function scanDownloaded(cfg: EmbeddedConfig): string | null {
  // A plain https://.../file.gguf URI is stored under the file name in its path.
  if (/^https?:\/\//i.test(cfg.modelUri)) {
    try {
      const named = path.join(cfg.modelsDir, decodeURIComponent(path.basename(new URL(cfg.modelUri).pathname)));
      return fs.existsSync(named) && fs.statSync(named).isFile() ? named : null;
    } catch {
      return null;
    }
  }
  const match = cfg.modelUri.match(/^hf:([^/:]+)\/([^/:]+)(?::([^/]+))?/);
  if (!match || !fs.existsSync(cfg.modelsDir)) return null;
  const [, user, , quant] = match;
  const candidates = fs
    .readdirSync(cfg.modelsDir)
    .filter((file) => file.toLowerCase().endsWith('.gguf') && file.startsWith(`hf_${user}_`) && (!quant || file.toLowerCase().includes(quant.toLowerCase())))
    .map((file) => path.join(cfg.modelsDir, file))
    .filter((file) => fs.statSync(file).isFile());
  return candidates.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0] ?? null;
}

/** The model file on disk, or null. Never touches the network. */
export async function locateModelFile(cfg: EmbeddedConfig): Promise<string | null> {
  if (cfg.modelPath) return fs.existsSync(cfg.modelPath) ? path.resolve(cfg.modelPath) : null;
  try {
    const mod = await loadNodeLlamaCpp();
    const resolved: string = await mod.resolveModelFile(cfg.modelUri, { directory: cfg.modelsDir, download: false, cli: false });
    if (fs.existsSync(resolved)) return resolved;
  } catch {
    // not downloaded under the expected name (or the runtime is missing): look for it by prefix below
  }
  return scanDownloaded(cfg);
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/**
 * CPU threads for generation. llama.cpp's own default (up to 4 threads) is fine on a desktop but makes a 1-2 core VM or container
 * hundreds of times slower, because the threads spin against each other for the same cores (measured: 0.03 s with 1 thread against
 * 13 s with the default on a 1-CPU machine). So: the number of cores that exist, never more. LOCAL_LLM_THREADS overrides.
 */
export function chooseThreads(llama: { cpuMathCores?: number }, env: NodeJS.ProcessEnv = process.env): number {
  const forced = Math.floor(Number(env.LOCAL_LLM_THREADS));
  if (Number.isFinite(forced) && forced > 0) return forced;
  const available = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(llama.cpuMathCores || available, available));
}

/** Tokens kept free for the chat template wrapped around the messages. */
const TEMPLATE_OVERHEAD_TOKENS = 64;
const MIN_ANSWER_TOKENS = 256;

export function createNodeLlamaCppEngine(env: NodeJS.ProcessEnv = process.env): EmbeddedEngine {
  const cfg = readEmbeddedConfig(env);
  let llamaPromise: Promise<{ mod: any; llama: any }> | null = null;
  let modelPromise: Promise<{ model: any; modelPath: string; name: string }> | null = null;

  const getLlama = () => {
    if (!llamaPromise) {
      llamaPromise = (async () => {
        const mod = await loadNodeLlamaCpp();
        // build: "never" - a missing prebuilt binary must never start a compiler during a request.
        const llama = await mod.getLlama({ build: 'never', logLevel: 'error' });
        return { mod, llama };
      })();
    }
    return llamaPromise;
  };

  const getModel = () => {
    if (!modelPromise) {
      const pending = (async () => {
        const { llama } = await getLlama();
        const modelPath = await locateModelFile(cfg);
        if (!modelPath) throw new EmbeddedEngineError('model_missing', 'The local model file has not been downloaded yet. Run: npm run setup:local-llm');
        const model = await llama.loadModel({ modelPath });
        return { model, modelPath, name: modelLabel(modelPath, cfg.modelUri) };
      })();
      modelPromise = pending;
      pending.catch(() => { if (modelPromise === pending) modelPromise = null; });
    }
    return modelPromise;
  };

  return {
    async status(): Promise<EmbeddedStatus> {
      const base = { modelUri: cfg.modelUri, modelName: cfg.modelPath ? modelLabel(cfg.modelPath) : modelLabel(cfg.modelUri.replace(/^hf:/, '').split(/[/:]/).pop() || cfg.modelUri) };
      let backend: string | undefined;
      try {
        const { llama } = await getLlama();
        backend = llama.gpu ? String(llama.gpu) : 'cpu';
      } catch (err: any) {
        const missing = err?.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (package|module)/i.test(String(err?.message));
        return {
          ...base,
          available: false,
          modelPresent: false,
          reason: missing
            ? 'The built-in runtime (node-llama-cpp) is not installed. Run npm install, or use Ollama / LM Studio.'
            : `The built-in runtime cannot run on this machine: ${String(err?.message || err).split('\n')[0].slice(0, 160)}`,
        };
      }
      const modelPath = await locateModelFile(cfg);
      return {
        ...base,
        available: true,
        backend,
        modelPresent: Boolean(modelPath),
        modelName: modelPath ? modelLabel(modelPath, cfg.modelUri) : base.modelName,
      };
    },

    async complete(request: EmbeddedRequest): Promise<EmbeddedResult> {
      let loaded: Awaited<ReturnType<typeof getModel>>;
      try {
        loaded = await getModel();
      } catch (err: any) {
        if (err instanceof EmbeddedEngineError) throw err;
        throw new EmbeddedEngineError('unavailable', `The built-in runtime could not load the model: ${String(err?.message || err).split('\n')[0].slice(0, 200)}`);
      }
      const { mod, llama } = await getLlama();
      const { model, name } = loaded;

      const system = request.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
      const turns = request.messages.filter((m) => m.role !== 'system');
      const last = turns[turns.length - 1];
      if (!last || last.role !== 'user') throw new EmbeddedEngineError('failed', 'The conversation must end with a user message.');

      const history: any[] = [];
      if (system) history.push({ type: 'system', text: system });
      for (const turn of turns.slice(0, -1)) {
        history.push(turn.role === 'user' ? { type: 'user', text: turn.content } : { type: 'model', response: [turn.content] });
      }

      // Evidence must never be silently dropped to make a prompt fit: an oversized prompt is refused, not trimmed.
      const promptTokens = model.tokenize([system, ...turns.map((m) => m.content)].join('\n')).length;
      const needed = promptTokens + TEMPLATE_OVERHEAD_TOKENS + MIN_ANSWER_TOKENS;
      const tooLong = (contextSize: number) => new EmbeddedEngineError(
        'prompt_too_long',
        "The prompt is longer than the local model's context window. Raise LOCAL_LLM_CONTEXT_SIZE (needs more memory) or use a model with a larger context.",
        { promptTokens, contextSize }
      );
      if (needed > cfg.contextSize) throw tooLong(cfg.contextSize);

      const context = await model.createContext({ contextSize: { min: Math.min(needed, cfg.contextSize), max: cfg.contextSize }, threads: chooseThreads(llama, env) });
      try {
        if (needed > context.contextSize) throw tooLong(context.contextSize);
        const room = context.contextSize - promptTokens - TEMPLATE_OVERHEAD_TOKENS;
        const maxTokens = Math.max(1, Math.min(request.maxTokens ?? room, room));

        const session = new mod.LlamaChatSession({ contextSequence: context.getSequence() });
        session.setChatHistory(history);

        let grammar: any;
        if (request.jsonSchema) grammar = await llama.createGrammarForJsonSchema(request.jsonSchema);
        else if (request.jsonObject) grammar = await llama.getGrammarFor('json');

        const options: Record<string, unknown> = { maxTokens, temperature: request.temperature };
        if (request.topP !== undefined) options.topP = request.topP;
        if (request.seed !== undefined) options.seed = request.seed;
        if (request.stop?.length) options.customStopTriggers = request.stop;
        if (grammar) options.grammar = grammar;
        if (request.signal) options.signal = request.signal;

        let result: { responseText: string; stopReason: string };
        try {
          result = await session.promptWithMeta(last.content, options);
        } catch (err: any) {
          if (request.signal?.aborted) throw new EmbeddedEngineError('aborted', 'The local model was stopped because it ran past its time limit.');
          throw new EmbeddedEngineError('failed', `The local model failed while writing: ${String(err?.message || err).split('\n')[0].slice(0, 200)}`);
        }

        return {
          text: result.responseText,
          finishReason: result.stopReason === 'maxTokens' ? 'length' : 'stop',
          promptTokens,
          completionTokens: model.tokenize(result.responseText).length,
          modelName: name,
        };
      } finally {
        await context.dispose().catch(() => {});
      }
    },

    async dispose(): Promise<void> {
      const pendingModel = modelPromise;
      const pendingLlama = llamaPromise;
      modelPromise = null;
      llamaPromise = null;
      try { await (await pendingModel)?.model.dispose(); } catch { /* never loaded */ }
      try { await (await pendingLlama)?.llama.dispose?.(); } catch { /* never loaded */ }
    },
  };
}

// ---------------------------------------------------------------------------
// One shared engine per configuration (loading a model is expensive: it stays resident for the life of the process)
// ---------------------------------------------------------------------------

let override: EmbeddedEngine | null = null;
let shared: { key: string; engine: EmbeddedEngine } | null = null;

/** Tests inject a fake engine here; pass null to go back to the real one. */
export function setEmbeddedEngineForTests(engine: EmbeddedEngine | null): void {
  override = engine;
}

export function getEmbeddedEngine(env: NodeJS.ProcessEnv = process.env): EmbeddedEngine {
  if (override) return override;
  const key = JSON.stringify(readEmbeddedConfig(env));
  if (!shared || shared.key !== key) {
    void shared?.engine.dispose();
    shared = { key, engine: createNodeLlamaCppEngine(env) };
  }
  return shared.engine;
}

export async function disposeEmbeddedEngine(): Promise<void> {
  const current = shared;
  shared = null;
  await current?.engine.dispose();
}
