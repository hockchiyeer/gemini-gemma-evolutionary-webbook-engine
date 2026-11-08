import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNodeLlamaCppEngine, EmbeddedEngineError, loadNodeLlamaCpp, locateModelFile, modelLabel, readEmbeddedConfig } from '../../server/embeddedLlm.ts';

// The built-in engine against the REAL llama.cpp runtime (the node-llama-cpp npm package), using a 160 KB random-weight model
// (tests/fixtures/tiny-random.gguf, built by a script described in the README) instead of a 3 GB download. The model writes nonsense,
// which is irrelevant: what is proven is that the runtime loads on this machine, loads a GGUF, runs a context, enforces a JSON-schema
// grammar, honours token limits and abort signals, and refuses prompts that do not fit. Skipped (loudly) if the runtime is not installed.

try {
  await loadNodeLlamaCpp();
} catch {
  console.log('embeddedRuntime tests SKIPPED: node-llama-cpp is not installed (optional dependency)');
  process.exit(0);
}

const fixture = path.resolve('tests/fixtures/tiny-random.gguf');
const env = { LOCAL_LLM_MODEL_PATH: fixture, LOCAL_LLM_CONTEXT_SIZE: '2048' } as NodeJS.ProcessEnv;
const engine = createNodeLlamaCppEngine(env);

// 1. configuration and model lookup
{
  assert.equal(readEmbeddedConfig({} as any).modelUri, 'hf:ggml-org/gemma-4-E2B-it-GGUF/gemma-4-E2B-it-Q4_0.gguf');
  assert.equal(readEmbeddedConfig({} as any).contextSize, 16384);
  assert.equal(readEmbeddedConfig({ LOCAL_LLM_CONTEXT_SIZE: '100' } as any).contextSize, 16384, 'a context below 2048 is ignored');
  assert.equal(readEmbeddedConfig({ LOCAL_LLM_CONTEXT_SIZE: '8192' } as any).contextSize, 8192);
  assert.equal(await locateModelFile(readEmbeddedConfig(env)), fixture);
  assert.equal(await locateModelFile(readEmbeddedConfig({ LOCAL_LLM_MODEL_PATH: '/nowhere/nothing.gguf' } as any)), null);
  assert.equal(
    await locateModelFile(readEmbeddedConfig({ LOCAL_LLM_MODELS_DIR: '/nowhere/models' } as any)),
    null,
    'a model that is not downloaded is reported missing, never fetched'
  );
  // a model downloaded from a plain URL is found under the file name in that URL; one downloaded from Hugging Face by its hf_<user>_ prefix
  const holder = fs.mkdtempSync(path.join(os.tmpdir(), 'models-'));
  fs.copyFileSync(fixture, path.join(holder, 'tiny-random.gguf'));
  assert.equal(await locateModelFile(readEmbeddedConfig({ LOCAL_LLM_MODEL_URI: 'https://example.com/some/dir/tiny-random.gguf', LOCAL_LLM_MODELS_DIR: holder } as any)), path.join(holder, 'tiny-random.gguf'));
  assert.equal(await locateModelFile(readEmbeddedConfig({ LOCAL_LLM_MODEL_URI: 'https://example.com/some/dir/other.gguf', LOCAL_LLM_MODELS_DIR: holder } as any)), null);
  fs.copyFileSync(fixture, path.join(holder, 'hf_someuser_Model-Q4_K_M.gguf'));
  assert.equal(await locateModelFile(readEmbeddedConfig({ LOCAL_LLM_MODEL_URI: 'hf:someuser/Model-GGUF:Q4_K_M', LOCAL_LLM_MODELS_DIR: holder } as any)), path.join(holder, 'hf_someuser_Model-Q4_K_M.gguf'));
  assert.equal(await locateModelFile(readEmbeddedConfig({ LOCAL_LLM_MODEL_URI: 'hf:someuser/Model-GGUF:Q8_0', LOCAL_LLM_MODELS_DIR: holder } as any)), null, 'a different quantisation is a different model');
  assert.equal(modelLabel('/m/hf_ggml-org_gemma-4-E2B-it-Q4_0.gguf', 'hf:ggml-org/gemma-4-E2B-it-GGUF/gemma-4-E2B-it-Q4_0.gguf'), 'gemma-4-E2B-it-Q4_0');
  assert.equal(modelLabel('/m/my-model.gguf'), 'my-model');
}

// 2. status
{
  const status = await engine.status();
  assert.equal(status.available, true, status.reason);
  assert.equal(status.modelPresent, true);
  assert.equal(status.modelName, 'tiny-random');
  assert.ok(status.backend, 'the backend (cpu / metal / cuda / vulkan) is reported');

  const noModel = await createNodeLlamaCppEngine({ LOCAL_LLM_MODEL_PATH: '/nowhere/x.gguf' } as any).status();
  assert.equal(noModel.available, true, 'the runtime works even when the model is missing');
  assert.equal(noModel.modelPresent, false);
}

// 3. generation under a JSON-schema grammar: always valid against the schema (finite schema, so the random model can finish)
const finiteSchema = {
  type: 'object',
  properties: { kind: { type: 'string', enum: ['alpha', 'beta', 'gamma'] }, ok: { type: 'boolean' }, count: { type: 'string', enum: ['1', '2', '3'] } },
  required: ['kind', 'ok', 'count'],
  additionalProperties: false,
};
{
  const result = await engine.complete({
    messages: [{ role: 'system', content: 'You answer in JSON.' }, { role: 'user', content: 'Describe something.' }],
    temperature: 0.4,
    maxTokens: 80,
    seed: 3,
    jsonSchema: finiteSchema,
  });
  assert.equal(result.modelName, 'tiny-random');
  const parsed = JSON.parse(result.text);
  assert.ok(['alpha', 'beta', 'gamma'].includes(parsed.kind), result.text);
  assert.equal(typeof parsed.ok, 'boolean');
  assert.ok(['1', '2', '3'].includes(parsed.count));
  assert.deepEqual(Object.keys(parsed).sort(), ['count', 'kind', 'ok']);
  assert.equal(result.finishReason, 'stop');
  assert.ok((result.promptTokens ?? 0) > 0 && (result.completionTokens ?? 0) > 0);

  // any-JSON mode
  const loose = await engine.complete({ messages: [{ role: 'user', content: 'x' }], temperature: 0, maxTokens: 12, jsonObject: true });
  assert.ok(loose.text.trimStart().startsWith('{') || loose.text.trimStart().startsWith('['), loose.text);

  // multi-turn history is accepted
  const multi = await engine.complete({
    messages: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'reply' }, { role: 'user', content: 'second' }],
    temperature: 0, maxTokens: 6,
  });
  assert.equal(typeof multi.text, 'string');
}

// 4. limits: a token budget cuts the answer and says so; an open string schema cannot finish on a random model
{
  const cut = await engine.complete({
    messages: [{ role: 'user', content: 'Write a title.' }],
    temperature: 0.4,
    maxTokens: 24,
    jsonSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false },
  });
  assert.equal(cut.finishReason, 'length', 'running out of tokens is reported as length, which the client can repair');
  assert.ok((cut.completionTokens ?? 0) <= 40);
}

// 5. abort: a time limit stops generation and surfaces as an aborted error
{
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(
    engine.complete({
      messages: [{ role: 'user', content: 'Keep going.' }],
      temperature: 0.4,
      maxTokens: 100000,
      jsonSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
      signal: controller.signal,
    }),
    (err: unknown) => err instanceof EmbeddedEngineError && err.reason === 'aborted'
  );
  // and the engine still works afterwards
  const after = await engine.complete({ messages: [{ role: 'user', content: 'again' }], temperature: 0, maxTokens: 80, jsonSchema: finiteSchema });
  assert.ok(JSON.parse(after.text).kind);
}

// 6. a prompt that does not fit is refused, never silently cut (evidence must not be dropped to make it fit)
{
  const huge = 'evidence '.repeat(6000);
  await assert.rejects(
    engine.complete({ messages: [{ role: 'user', content: huge }], temperature: 0.4 }),
    (err: unknown) => err instanceof EmbeddedEngineError && err.reason === 'prompt_too_long' && /LOCAL_LLM_CONTEXT_SIZE/.test(err.message)
  );
  await assert.rejects(
    engine.complete({ messages: [{ role: 'assistant', content: 'no user turn' }], temperature: 0.4 }),
    (err: unknown) => err instanceof EmbeddedEngineError && err.reason === 'failed'
  );
}

// 7. a missing model file is a clear, specific error
{
  const missing = createNodeLlamaCppEngine({ LOCAL_LLM_MODEL_PATH: '/nowhere/x.gguf' } as any);
  await assert.rejects(
    missing.complete({ messages: [{ role: 'user', content: 'x' }], temperature: 0.4 }),
    (err: unknown) => err instanceof EmbeddedEngineError && err.reason === 'model_missing' && /npm run setup:local-llm/.test(err.message)
  );
}

await engine.dispose();
console.log('embeddedRuntime tests passed');
