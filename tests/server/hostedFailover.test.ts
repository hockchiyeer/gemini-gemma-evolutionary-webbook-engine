import assert from 'node:assert/strict';
import { CHAPTER_CONCURRENCY, MODEL_FAILOVER_DEPTH, assembleWebBook } from '../../src/services/evolutionService.ts';
import type { WebPageGenotype } from '../../src/types.ts';

const globals = globalThis as unknown as Record<string, unknown>;
globals.window = { location: { origin: 'http://localhost:3000', href: 'http://localhost:3000/' } };
const realSetTimeout = globalThis.setTimeout;
globals.setTimeout = ((handler: () => void) => realSetTimeout(handler, 0)) as unknown as typeof setTimeout;
console.warn = () => {};
console.error = () => {};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const timeout504 = () => json({ error: { code: 504, reason: 'timeout', message: 'Gemini did not answer within 50 s', retriesExhausted: true } }, 504);
const chapterText = (n: number) => Array.from({ length: 160 }, (_, i) => `word${n}x${i}`).join(' ') + '.';
const outline = (count: number) => ({
  topic: 'T',
  outline: Array.from({ length: count }, (_, i) => ({ title: `Chapter title ${i + 1}`, focus: 'Focus one. Focus two.', terms: ['a', 'b', 'c', 'd'], subTopicTitles: ['x', 'y', 'z'], visualSeed: `seed ${i}` })),
});

let requests: Array<{ model: string; kind: 'outline10' | 'outline6' | 'chapter' }> = [];
let inFlight = 0;
let peak = 0;
let handler: (req: { model: string; kind: string }) => Response = () => json({ text: '[]' });

globals.fetch = async (_input: unknown, init?: { body?: unknown }) => {
  const body = JSON.parse(String(init?.body ?? '{}'));
  const prompt = String(body.contents);
  const outlineCount = body.config?.responseSchema?.properties?.outline ? Number(prompt.match(/exactly (\d+) chapters/)?.[1]) : null;
  const kind = outlineCount === 10 ? 'outline10' : outlineCount === 6 ? 'outline6' : 'chapter';
  requests.push({ model: body.model, kind });
  inFlight += 1;
  peak = Math.max(peak, inFlight);
  try {
    await new Promise((resolve) => setImmediate(resolve));
    const forced = handler({ model: body.model, kind });
    if (forced.status !== 200 || forced.headers.get('x-pass') !== '1') return forced;
    if (kind !== 'chapter') return json({ text: JSON.stringify(outline(outlineCount!)) });
    const n = Number(prompt.match(/Chapter (\d+): /)?.[1]);
    return json({ text: JSON.stringify({ content: chapterText(n), definitions: [{ term: `Term ${n}`, description: 'A clear description of this term in context.' }], subTopics: [{ title: `Angle ${n}`, summary: 'A short analysis of this angle on the topic.' }] }) });
  } finally {
    inFlight -= 1;
  }
};
const pass = () => new Response('{}', { status: 200, headers: { 'x-pass': '1' } });
const reset = () => { requests = []; inFlight = 0; peak = 0; };

const pages: WebPageGenotype[] = Array.from({ length: 6 }, (_, i) => ({
  id: `g${i}`, url: `https://example${i}.org/a`, title: `Title ${i}`,
  content: 'Evidence sentence about the topic. '.repeat(20), definitions: [], subTopics: [],
  informativeScore: 0.8, authorityScore: 0.8, fitness: 0,
}));
const searchResult = { sourceMode: 'gemini' as const, generationNote: 'Evidence gathered.', artifacts: { groundingChunks: [] } };
const opts = { mode: 'google_duckduckgo' as const, geminiModel: 'gemini-3.8-flash' };

// --- 1. A timeout the server already gave up on is not retried on the same model ---------------------------------------
{
  reset();
  handler = ({ model }) => (model === 'gemini-3.8-flash' ? timeout504() : pass());
  const book = await assembleWebBook(pages, 'T', searchResult, opts);
  assert.equal(book.chapters.length, 10);
  const slow = requests.filter((r) => r.model === 'gemini-3.8-flash');
  assert.equal(slow.length, 11, `one outline + ten chapters, each asked once on the slow model (asked ${slow.length})`);
}

// --- 2. Chapter requests can fail over across more than three models ---------------------------------------------------------------
{
  assert.ok(MODEL_FAILOVER_DEPTH >= 4);
  reset();
  const dead = new Set(['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash']);
  handler = ({ model, kind }) => (kind === 'chapter' && dead.has(model) ? timeout504() : pass());
  const book = await assembleWebBook(pages, 'T', searchResult, opts);
  assert.equal(book.sourceMode, 'gemini', 'the fourth model writes the chapters instead of the book falling to the offline path');
  assert.equal(book.chapters.length, 10);
  assert.ok(requests.some((r) => r.kind === 'chapter' && r.model === 'gemini-3.5-flash-lite'));
}

// --- 3. A 10-chapter outline that times out does not use the whole chain before the 6-chapter retry --------------------
{
  reset();
  handler = ({ kind }) => (kind === 'outline10' ? timeout504() : pass());
  const book = await assembleWebBook(pages, 'T', searchResult, opts);
  const full = requests.filter((r) => r.kind === 'outline10');
  assert.equal(full.length, 2, `the 10-chapter outline is tried on two models only (tried ${full.length})`);
  assert.ok(requests.some((r) => r.kind === 'outline6'), 'the 6-chapter outline follows');
  assert.equal(book.sourceMode, 'gemini');
  assert.equal(book.chapters.length, 6);
  assert.match(book.generationNote || '', /Outline generated via 6-chapter retry/);
}

// --- 4. Hosted chapter concurrency is low enough not to trigger rate limits --------------------------------------------
{
  reset();
  handler = () => pass();
  await assembleWebBook(pages, 'T', searchResult, opts);
  assert.ok(CHAPTER_CONCURRENCY <= 2);
  assert.ok(peak > 1 && peak <= CHAPTER_CONCURRENCY, `chapters still run in parallel, within the cap (peak ${peak})`);
}

console.log('hostedFailover tests passed');
