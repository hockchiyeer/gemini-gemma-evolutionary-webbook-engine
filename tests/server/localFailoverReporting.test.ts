import assert from 'node:assert/strict';
import { LocalLlmError, describeLocalFailure } from '../../server/localLlm.ts';
import { EmbeddedEngineError } from '../../server/embeddedLlm.ts';
import { assembleWebBook, localFailoverNote } from '../../src/services/evolutionService.ts';
import type { WebPageGenotype } from '../../src/types.ts';

const globals = globalThis as unknown as Record<string, unknown>;
globals.window = { location: { origin: 'http://localhost:3000', href: 'http://localhost:3000/' } };
const realSetTimeout = globalThis.setTimeout;
globals.setTimeout = ((handler: () => void) => realSetTimeout(handler, 0)) as unknown as typeof setTimeout;
console.warn = () => {};
console.error = () => {};

// --- 1. Every local failure is described by a reason and a short single-line message -----------------------------------------
{
  assert.deepEqual(describeLocalFailure(new LocalLlmError('local_timeout', 'The local model took too long.')), { reason: 'local_timeout', message: 'The local model took too long.' });
  assert.equal(describeLocalFailure(new EmbeddedEngineError('unavailable', 'The built-in runtime could not start.')).reason, 'local_unreachable');
  assert.equal(describeLocalFailure(new EmbeddedEngineError('aborted', 'x')).reason, 'local_timeout');
  const generic = describeLocalFailure(new Error('boom'));
  assert.equal(generic.reason, 'local_rejected');
  assert.ok(!generic.message.includes('\n'));
  assert.ok(describeLocalFailure(new LocalLlmError('local_rejected', 'a\n'.repeat(400))).message.length <= 300, 'long messages are cut');
}

// --- 2. The notice text -----------------------------------------------------------------------------------------------------
{
  assert.equal(localFailoverNote(new Error('plain')), '');
  assert.equal(localFailoverNote(null), '');
  const note = localFailoverNote({ localFailover: { reason: 'local_timeout', message: 'The local model took too long.' } });
  assert.equal(note, ' The local model was tried in its place and failed too (local_timeout: The local model took too long).');
}

// --- 3. End to end: Google's daily quota is used up, the local model failed too -> the book says both -------------------------
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
globals.fetch = async () => json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', reason: 'quota_daily', message: 'daily quota', localFailover: { reason: 'local_timeout', message: 'The local model took too long to answer.' } } }, 429);
const pages: WebPageGenotype[] = ['新谣的兴起', '海蝶音乐的成立', '新谣节', '电视剧歌曲'].map((t, i) => ({
  id: `p${i}`, url: `https://site${i}.org/a`, title: `${t} - 站点${i}`,
  content: `${t}是一段完整的说明，包含若干具体事实与背景介绍，并且足够长以便写成章节。`.repeat(4), definitions: [], subTopics: [],
  informativeScore: 0.8, authorityScore: 0.8, fitness: 0,
}));
const searchResult = { sourceMode: 'gemini' as const, generationNote: 'Evidence gathered.', artifacts: { groundingChunks: [] } };
{
  const book = await assembleWebBook(pages, '新加坡歌谣', searchResult, { mode: 'google_duckduckgo', geminiModel: 'gemini-3.6-flash' });
  assert.notEqual(book.sourceMode, 'gemini');
  assert.match(book.generationNote || '', /local model was tried in its place and failed too \(local_timeout: The local model took too long to answer\)/);
}
{
  await assert.rejects(
    assembleWebBook(pages, '新加坡歌谣', searchResult, { mode: 'off', geminiModel: 'gemini-3.6-flash' }),
    /local_timeout: The local model took too long to answer/,
    'Gemini-only mode reports it in the error too'
  );
}

console.log('localFailoverReporting tests passed');
