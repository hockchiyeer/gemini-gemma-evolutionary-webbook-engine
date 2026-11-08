import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { loadNodeLlamaCpp } from '../../server/embeddedLlm.ts';

// scripts/setup-local-llm.mjs is what `npm install` runs (as `postinstall`) to set up the built-in local model. These tests run it as a
// real child process in a scratch directory, so any file it writes is visible, and check what a user would see. The 3 GB download itself is
// never started here: every scenario either skips, uses the tiny test model, or fails fast.

const script = path.resolve('scripts/setup-local-llm.mjs');
const fixture = path.resolve('tests/fixtures/tiny-random.gguf');
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'setup-llm-'));
const sha = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const run = (args: string[], env: Record<string, string>, cwd: string) => {
  // a clean environment: nothing from the developer's shell or CI may change the outcome
  const clean: Record<string, string> = { PATH: process.env.PATH || '', HOME: process.env.HOME || cwd };
  const result = spawnSync(process.execPath, [script, ...args], { cwd, env: { ...clean, ...env }, encoding: 'utf8', timeout: 120_000 });
  const output = `${result.stdout}${result.stderr}`.split('\n').filter((line) => !/Vulkan/.test(line)).join('\n');
  return { code: result.status, output };
};

// Same, without blocking this process (needed when the test itself serves something the script talks to).
const runAsync = (args: string[], env: Record<string, string>, cwd: string) =>
  new Promise<{ code: number | null; output: string }>((resolve) => {
    const clean: Record<string, string> = { PATH: process.env.PATH || '', HOME: process.env.HOME || cwd };
    const child = spawn(process.execPath, [script, ...args], { cwd, env: { ...clean, ...env } });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('close', (code) => resolve({ code, output: output.split('\n').filter((line) => !/Vulkan/.test(line)).join('\n') }));
  });

let runtimeInstalled = true;
try { await loadNodeLlamaCpp(); } catch { runtimeInstalled = false; }

// 1. Skips: every reason leaves the install untouched, exits 0 and says how to set up later
for (const [name, env, reason] of [
  ['CI', { CI: 'true' }, /CI environment/],
  ['opt-out', { SKIP_LOCAL_LLM_SETUP: '1' }, /SKIP_LOCAL_LLM_SETUP/],
  ['production', { NODE_ENV: 'production' }, /production install/],
  ['npm production flag', { npm_config_production: 'true' }, /production install/],
  ['global', { npm_config_global: 'true' }, /global install/],
  ['external server chosen', { LOCAL_LLM_ENGINE: 'http' }, /external model server/],
] as const) {
  const cwd = scratch();
  const { code, output } = run(['--postinstall'], env, cwd);
  assert.equal(code, 0, `${name}: ${output}`);
  assert.match(output, /skipped/, name);
  assert.match(output, reason, name);
  assert.match(output, /npm run setup:local-llm/, name);
  assert.deepEqual(fs.readdirSync(cwd), [], `${name}: a skipped setup must create nothing`);
}

if (!runtimeInstalled) {
  console.log('setupLocalLlm: runtime scenarios SKIPPED (node-llama-cpp is not installed)');
} else {
  // 2. Postinstall with a model already on disk, not load-tested on request
  {
    const cwd = scratch();
    const { code, output } = run(['--postinstall'], { LOCAL_LLM_MODEL_PATH: fixture, LOCAL_LLM_VERIFY: 'off' }, cwd);
    assert.equal(code, 0, output);
    assert.match(output, /runtime OK/);
    assert.match(output, /READY: the runtime and the model file are in place \(not load-tested/);
    assert.deepEqual(fs.readdirSync(cwd), []);
  }

  // 3. The real thing: manual run loads the model and writes tokens, and only then says READY
  {
    const cwd = scratch();
    const { code, output } = run([], { LOCAL_LLM_MODEL_PATH: fixture }, cwd);
    assert.equal(code, 0, output);
    assert.match(output, /loading the model and writing a few tokens/);
    assert.match(output, /READY: the built-in local model works \(tiny-random\.gguf, /);
    assert.doesNotMatch(output, /NOT READY/);
  }

  // 4. Settings in .env are read, and the file is never written
  {
    const cwd = scratch();
    const envFile = path.join(cwd, '.env');
    fs.writeFileSync(envFile, `GEMINI_API_KEY=\nLOCAL_LLM_MODEL_PATH=${fixture}\nLOCAL_LLM_VERIFY=off\n`);
    const before = sha(envFile);
    const { code, output } = run(['--postinstall'], {}, cwd);
    assert.equal(code, 0, output);
    assert.match(output, /model found: tiny-random\.gguf/, '.env settings are honoured');
    assert.equal(sha(envFile), before, 'the setup never edits .env');
    assert.deepEqual(fs.readdirSync(cwd), ['.env']);
  }

  // 5. Problems never fail an install, but fail the manual command
  {
    const cwd = scratch();
    const bad = run(['--postinstall'], { LOCAL_LLM_MODEL_PATH: '/nowhere/missing.gguf' }, cwd);
    assert.equal(bad.code, 0, 'postinstall exits 0 even when the setup is not usable');
    assert.match(bad.output, /NOT READY: LOCAL_LLM_MODEL_PATH does not exist/);
    const manual = run([], { LOCAL_LLM_MODEL_PATH: '/nowhere/missing.gguf' }, cwd);
    assert.equal(manual.code, 1, 'the manual command reports failure');

    const noDownload = run(['--postinstall'], { LOCAL_LLM_DOWNLOAD: 'off', LOCAL_LLM_MODELS_DIR: path.join(cwd, 'models') }, cwd);
    assert.equal(noDownload.code, 0);
    assert.match(noDownload.output, /NOT READY: the model is not downloaded \(LOCAL_LLM_DOWNLOAD=off\)/);
    assert.match(noDownload.output, /npm run setup:local-llm/);
    assert.equal(fs.existsSync(path.join(cwd, 'models')), false, 'no download, no folder');

    const check = run(['--check'], { LOCAL_LLM_MODELS_DIR: path.join(cwd, 'models') }, cwd);
    assert.equal(check.code, 1);
    assert.match(check.output, /no model file to check/);
  }

  // 6. No internet: fails fast with a clear message instead of hanging the install
  {
    const cwd = scratch();
    const started = Date.now();
    const { code, output } = run(['--postinstall'], { LOCAL_LLM_MODEL_URI: 'http://127.0.0.1:9/model-Q4.gguf', LOCAL_LLM_MODELS_DIR: path.join(cwd, 'models') }, cwd);
    assert.equal(code, 0, output);
    assert.ok(Date.now() - started < 30_000, 'an unreachable host must not hang the install');
    assert.match(output, /NOT READY: cannot reach 127\.0\.0\.1:9 to download the model/);
    assert.match(output, /only the model file is missing/);
    assert.equal(fs.existsSync(path.join(cwd, '.env')), false);
    assert.equal(fs.existsSync(path.join(cwd, 'models')), false, 'a failed download must not leave an empty models folder behind');
  }

  // 7. A running Ollama / LM Studio makes a second copy pointless
  {
    const server = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'gemma4:e4b' }] })); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const cwd = scratch();
    const { code, output } = await runAsync(['--postinstall'], { LOCAL_LLM_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, LOCAL_LLM_MODELS_DIR: path.join(cwd, 'models') }, cwd);
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    assert.equal(code, 0, output);
    assert.match(output, /already running at .* not downloading a second copy/);
    assert.match(output, /READY: using your running local model server/);
    assert.equal(fs.existsSync(path.join(cwd, 'models')), false);
  }
}

// 8. The whole download path, from a local server instead of Hugging Face: download with progress, load test, then a second run that finds
//    the file and downloads nothing. (A 3 GB download is the same code path with a bigger file.)
if (runtimeInstalled) {
  const fixtureBytes = fs.readFileSync(fixture);
  let served = 0;
  const server = http.createServer((req, res) => { served += 1; res.setHeader('content-type', 'application/octet-stream'); res.setHeader('content-length', fixtureBytes.length); res.end(fixtureBytes); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const uri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/tiny-random.gguf`;
  const cwd = scratch();
  const modelsDir = path.join(cwd, 'models');

  const first = await runAsync([], { LOCAL_LLM_MODEL_URI: uri, LOCAL_LLM_MODELS_DIR: modelsDir }, cwd);
  assert.equal(first.code, 0, first.output);
  assert.match(first.output, /downloading the model/);
  assert.match(first.output, /100%/);
  assert.match(first.output, /downloaded: tiny-random\.gguf/);
  assert.match(first.output, /READY: the built-in local model works/);
  assert.equal(sha(path.join(modelsDir, 'tiny-random.gguf')), crypto.createHash('sha256').update(fixtureBytes).digest('hex'), 'the file is intact');
  const servedAfterFirst = served;
  assert.ok(servedAfterFirst >= 1);

  const second = await runAsync([], { LOCAL_LLM_MODEL_URI: uri, LOCAL_LLM_MODELS_DIR: modelsDir }, cwd);
  assert.equal(second.code, 0, second.output);
  assert.match(second.output, /model found: tiny-random\.gguf/);
  assert.doesNotMatch(second.output, /downloading the model/);
  assert.equal(served, servedAfterFirst, 'the second run must not touch the network');
  assert.match(second.output, /READY/);

  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

console.log('setupLocalLlm tests passed');
