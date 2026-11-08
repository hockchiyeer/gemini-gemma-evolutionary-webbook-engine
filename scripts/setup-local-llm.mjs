#!/usr/bin/env node
/**
 * Sets up the built-in local model so books can be written with no Gemini key and no separate model server.
 *
 *   npm install                    runs this with --postinstall (never fails the install; says what it did and what it could not do)
 *   npm run setup:local-llm        the same, verbose; exits 1 if the setup is not usable
 *   npm run local-llm:check        no download: only loads the model and writes a few tokens, to prove it works
 *
 * What it does, in order, and only reports what it verified:
 *   1. checks that the runtime (node-llama-cpp, installed by npm) loads on this machine
 *   2. looks for the model file; if missing, downloads it (resumable, free-disk-space check, progress)
 *   3. loads the model and generates a tiny schema-constrained answer
 * It never edits .env, never runs a compiler, and never starts a background process.
 *
 * Opt-outs:  SKIP_LOCAL_LLM_SETUP=1 (do nothing)   LOCAL_LLM_DOWNLOAD=off (no download)   LOCAL_LLM_VERIFY=off (no load test)
 *            LOCAL_LLM_ENGINE=http (you use Ollama / LM Studio)   Skipped automatically in CI and production installs.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_LOCAL_MODEL_SIZE_GB, DEFAULT_LOCAL_MODEL_URI } from '../server/localModelDefaults.mjs';

const args = new Set(process.argv.slice(2));
const postinstall = args.has('--postinstall');
const checkOnly = args.has('--check');
const TAG = '[local-llm]';
const say = (message = '') => console.log(message ? `${TAG} ${message}` : '');
const off = (value) => ['off', '0', 'false', 'no'].includes(String(value || '').trim().toLowerCase());
const on = (value) => ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());

// Settings may live in .env (read-only here: this script never writes it). Real environment variables win.
try {
  const dotenv = await import('dotenv');
  dotenv.config({ path: path.join(process.cwd(), '.env'), quiet: true });
} catch {
  // dotenv is optional for this script
}

/** Postinstall never fails an install: problems are printed with the command that fixes them, and the exit code stays 0. */
function finish(ok, headline, detail = []) {
  say();
  say(`${ok ? 'READY' : 'NOT READY'}: ${headline}`);
  for (const line of detail) say(`  ${line}`);
  say();
  process.exit(ok || postinstall ? 0 : 1);
}

const skipped = (why) => {
  say(`skipped (${why}). To set it up later: npm run setup:local-llm`);
  process.exit(0);
};

if (postinstall) {
  if (on(process.env.SKIP_LOCAL_LLM_SETUP)) skipped('SKIP_LOCAL_LLM_SETUP is set');
  if (on(process.env.CI)) skipped('CI environment');
  if (process.env.NODE_ENV === 'production' || on(process.env.npm_config_production)) skipped('production install');
  if (on(process.env.npm_config_global)) skipped('global install');
  if (String(process.env.LOCAL_LLM_ENGINE || '').toLowerCase() === 'http') skipped('LOCAL_LLM_ENGINE=http: using an external model server');
}

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 20) {
  finish(false, `Node ${process.versions.node} is too old for the built-in runtime (needs Node 20+).`, ['Use Node 20+, or run Ollama / LM Studio instead (see README 6b).']);
}

const modelUri = String(process.env.LOCAL_LLM_MODEL_URI || DEFAULT_LOCAL_MODEL_URI).trim();
const explicitPath = String(process.env.LOCAL_LLM_MODEL_PATH || '').trim();
const modelsDir = path.resolve(String(process.env.LOCAL_LLM_MODELS_DIR || '').trim() || path.join(process.cwd(), 'models'));
const gb = (bytes) => (bytes / 1024 ** 3).toFixed(2);

// 1. runtime ---------------------------------------------------------------------------------------------------------------
let runtime;
let llama;
try {
  runtime = await import('node-llama-cpp');
  // build: 'never' - if there is no prebuilt binary for this machine we say so; we never start a compiler during npm install.
  llama = await runtime.getLlama({ build: 'never', logLevel: 'error' });
} catch (err) {
  const missing = err?.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (package|module)/i.test(String(err?.message));
  finish(false, missing ? 'the built-in runtime (node-llama-cpp) is not installed.' : 'the built-in runtime cannot run on this machine.', [
    missing ? 'It is an optional dependency: run `npm install` again, or check that npm did not skip optional packages.' : String(err?.message || err).split('\n')[0].slice(0, 200),
    'Alternative: run Ollama or LM Studio (README 6b); the app detects it automatically.',
  ]);
}
say(`runtime OK (${llama.gpu ? `GPU backend: ${llama.gpu}` : 'CPU only'})`);

// 2. model file ------------------------------------------------------------------------------------------------------------
async function findModel() {
  if (explicitPath) return fs.existsSync(explicitPath) ? path.resolve(explicitPath) : null;
  try {
    const resolved = await runtime.resolveModelFile(modelUri, { directory: modelsDir, download: false, cli: false });
    if (fs.existsSync(resolved)) return resolved;
  } catch {
    // not downloaded under the expected name
  }
  if (/^https?:\/\//i.test(modelUri)) {
    try {
      const named = path.join(modelsDir, decodeURIComponent(path.basename(new URL(modelUri).pathname)));
      return fs.existsSync(named) && fs.statSync(named).isFile() ? named : null;
    } catch {
      return null;
    }
  }
  const match = modelUri.match(/^hf:([^/:]+)\/([^/:]+)(?::([^/]+))?/);
  if (match && fs.existsSync(modelsDir)) {
    const [, user, , quant] = match;
    const found = fs.readdirSync(modelsDir).filter((f) => f.toLowerCase().endsWith('.gguf') && f.startsWith(`hf_${user}_`) && (!quant || f.toLowerCase().includes(quant.toLowerCase())));
    if (found.length) return path.join(modelsDir, found[0]);
  }
  return null;
}

let modelPath = await findModel();

if (modelPath) {
  say(`model found: ${path.basename(modelPath)}`);
} else if (checkOnly) {
  finish(false, 'no model file to check.', [explicitPath ? `LOCAL_LLM_MODEL_PATH does not exist: ${explicitPath}` : 'Download it first: npm run setup:local-llm']);
} else if (explicitPath) {
  finish(false, `LOCAL_LLM_MODEL_PATH does not exist: ${explicitPath}`, ['Fix the path, or unset it to let the setup download the default model.']);
} else if (postinstall && off(process.env.LOCAL_LLM_DOWNLOAD)) {
  finish(false, 'the model is not downloaded (LOCAL_LLM_DOWNLOAD=off).', ['Download it when you want it: npm run setup:local-llm']);
} else {
  // An Ollama / LM Studio server that already has a model makes a second copy pointless: tell the user and stop.
  if (postinstall && String(process.env.LOCAL_LLM_ENGINE || 'auto').toLowerCase() === 'auto') {
    try {
      const base = String(process.env.LOCAL_LLM_BASE_URL || 'http://localhost:11434').replace(/\/+$/, '').replace(/\/v1$/i, '');
      const response = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(1500) });
      const data = response.ok ? await response.json() : null;
      if (Array.isArray(data?.data) && data.data.length) {
        say(`a local model server is already running at ${base} with ${data.data.length} model(s): not downloading a second copy.`);
        finish(true, 'using your running local model server.', ['The app picks it up automatically (check: /api/local-llm/health).']);
      }
    } catch {
      // nothing running: carry on and download
    }
  }

  const needGb = DEFAULT_LOCAL_MODEL_SIZE_GB * 1.15;
  try {
    // the models folder does not exist yet (and must not be created if the download then fails): measure the nearest folder that does
    let measured = modelsDir;
    while (!fs.existsSync(measured) && path.dirname(measured) !== measured) measured = path.dirname(measured);
    const stats = fs.statfsSync(measured);
    const freeGb = (stats.bavail * stats.bsize) / 1024 ** 3;
    if (freeGb < needGb) {
      finish(false, `not enough free disk space for the model (${freeGb.toFixed(1)} GB free, about ${needGb.toFixed(1)} GB needed).`, [`Free some space or set LOCAL_LLM_MODELS_DIR to another drive, then: npm run setup:local-llm`]);
    }
  } catch {
    // statfs is not available everywhere: the download reports its own errors
  }

  // Fail fast when the host cannot be reached at all: the downloader would otherwise retry silently for a very long time.
  const probeUrl = modelUri.startsWith('hf:') ? String(process.env.HF_ENDPOINT || 'https://huggingface.co') : /^https?:\/\//i.test(modelUri) ? modelUri : '';
  if (probeUrl) {
    try {
      await fetch(probeUrl, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(8000) });
    } catch (err) {
      finish(false, `cannot reach ${new URL(probeUrl).host} to download the model (${String(err?.cause?.code || err?.cause?.errors?.[0]?.code || err?.name || err?.message).slice(0, 60)}).`, [
        'The runtime is installed; only the model file is missing. When you are online: npm run setup:local-llm',
        'Or download a .gguf yourself and set LOCAL_LLM_MODEL_PATH to it (README 6b).',
      ]);
    }
  }

  fs.mkdirSync(modelsDir, { recursive: true });
  say(`downloading the model (about ${DEFAULT_LOCAL_MODEL_SIZE_GB} GB, once; resumable): ${modelUri}`);
  say(`into ${modelsDir}   (Ctrl+C is safe: re-running continues where it stopped)`);
  let lastStep = -1;
  // A download that stops receiving bytes is abandoned (re-running resumes it) instead of hanging the install.
  const watchdog = new AbortController();
  let watchdogTimer;
  const arm = (ms) => {
    clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(() => watchdog.abort(new Error(`no download progress for ${Math.round(ms / 1000)} seconds`)), ms);
  };
  arm(120_000);
  try {
    modelPath = await runtime.resolveModelFile(modelUri, {
      directory: modelsDir,
      download: 'auto',
      cli: false,
      signal: watchdog.signal,
      onProgress: ({ totalSize, downloadedSize }) => {
        arm(60_000);
        if (!totalSize) return;
        const step = Math.floor((downloadedSize / totalSize) * 100 / 5) * 5;
        if (step !== lastStep) {
          lastStep = step;
          say(`  ${String(step).padStart(3)}%   ${gb(downloadedSize)} / ${gb(totalSize)} GB`);
        }
      },
    });
  } catch (err) {
    clearTimeout(watchdogTimer);
    finish(false, 'the model download did not finish.', [
      String(err?.message || err).split('\n')[0].slice(0, 200),
      'Check your connection (Hugging Face must be reachable), then run: npm run setup:local-llm   (it resumes).',
      'Or put a .gguf file anywhere and set LOCAL_LLM_MODEL_PATH to it.',
    ]);
  }
  clearTimeout(watchdogTimer);
  say(`downloaded: ${path.basename(modelPath)}`);
}

// 3. prove it works --------------------------------------------------------------------------------------------------------
if (postinstall && off(process.env.LOCAL_LLM_VERIFY)) {
  finish(true, `the runtime and the model file are in place (not load-tested: LOCAL_LLM_VERIFY=off).`, [`Model: ${path.basename(modelPath)}`]);
}

say('loading the model and writing a few tokens to check it works...');
let model;
let context;
try {
  const started = Date.now();
  model = await llama.loadModel({ modelPath });
  // As in server/embeddedLlm.ts: never more threads than cores (llama.cpp's default makes small VMs hundreds of times slower).
  const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  const threads = Number(process.env.LOCAL_LLM_THREADS) > 0 ? Math.floor(Number(process.env.LOCAL_LLM_THREADS)) : Math.max(1, Math.min(llama.cpuMathCores || cores, cores));
  context = await model.createContext({ contextSize: { min: 512, max: 2048 }, threads });
  const session = new runtime.LlamaChatSession({ contextSequence: context.getSequence() });
  const grammar = await llama.createGrammarForJsonSchema({ type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false });
  const result = await session.promptWithMeta('Reply with a JSON object saying ok is true.', { grammar, maxTokens: 24, temperature: 0 });
  const parsed = grammar.parse(result.responseText);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (typeof parsed?.ok !== 'boolean') throw new Error('the model answered, but not in the requested JSON form');
  finish(true, `the built-in local model works (${path.basename(modelPath)}, ${llama.gpu ? llama.gpu : 'CPU'}, loaded and answered in ${seconds}s).`, [
    'No Gemini key and no Ollama needed: start the app (npm run dev / npm start) and generate a book.',
    'Check any time:  /api/local-llm/health   or   npm run local-llm:check',
  ]);
} catch (err) {
  finish(false, 'the model file is there but could not be used.', [
    String(err?.message || err).split('\n')[0].slice(0, 220),
    'A damaged download is the usual cause: delete the file in the models folder and run npm run setup:local-llm again.',
    'Not enough memory is the other: try the smaller default, or Ollama / LM Studio.',
  ]);
} finally {
  await context?.dispose?.().catch?.(() => {});
  await model?.dispose?.().catch?.(() => {});
}
