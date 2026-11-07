import assert from 'node:assert/strict';
import {
  CHAPTER_CONCURRENCY,
  CHAPTER_TARGET_WORDS,
  assembleWebBook,
  buildEvidenceDigest,
  evolve,
  searchAndExtract,
} from '../../src/services/evolutionService.ts';
import type { WebPageGenotype } from '../../src/types.ts';

const globals = globalThis as unknown as Record<string, unknown>;
globals.window = { location: { origin: 'http://localhost:3000', href: 'http://localhost:3000/' } };
const realSetTimeout = globalThis.setTimeout;
globals.setTimeout = ((handler: () => void) => realSetTimeout(handler, 0)) as unknown as typeof setTimeout;
console.warn = () => {};
console.error = () => {};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const chapterText = (n: number) =>
  Array.from({ length: 160 }, (_, i) => `word${n}x${i}`).join(' ') + '.';

let handler: (body: any, ctx: { chapterNumber: number | null }) => Promise<Response> | Response = () => json({ text: '[]' });
let requests: any[] = [];
let inFlight = 0;
let peakInFlight = 0;

globals.fetch = async (input: unknown, init?: { body?: unknown }) => {
  const url = new URL(typeof input === 'string' ? input : (input as { url?: string }).url ?? String(input));
  assert.equal(url.pathname, '/api/gemini/generate', `unexpected request to ${url.pathname}`);
  const body = JSON.parse(String(init?.body ?? '{}'));
  requests.push(body);
  const chapterNumber = Number(String(body.contents).match(/Chapter (\d+): /)?.[1] ?? NaN);
  inFlight += 1;
  peakInFlight = Math.max(peakInFlight, inFlight);
  try {
    await new Promise((resolve) => setImmediate(resolve));
    return await handler(body, { chapterNumber: Number.isFinite(chapterNumber) ? chapterNumber : null });
  } finally {
    inFlight -= 1;
  }
};

const reset = () => {
  requests = [];
  inFlight = 0;
  peakInFlight = 0;
};

const outline = Array.from({ length: 10 }, (_, i) => ({
  title: `Topic chapter ${i + 1}`,
  focus: 'Focus one. Focus two.',
  terms: ['alpha', 'beta', 'gamma', 'delta'],
  subTopicTitles: ['one', 'two', 'three'],
  visualSeed: `seed ${i}`,
}));

const goodHandler = (body: any, { chapterNumber }: { chapterNumber: number | null }) => {
  if (body.config?.responseSchema?.properties?.outline) return json({ text: JSON.stringify({ topic: 'T', outline }) });
  if (chapterNumber != null) {
    return json({
      text: JSON.stringify({
        content: chapterText(chapterNumber),
        definitions: [{ term: `Term ${chapterNumber}`, description: 'A clear description of this term in context.' }],
        subTopics: [{ title: `Angle ${chapterNumber}`, summary: 'A short analysis of this angle on the topic.' }],
      }),
    });
  }
  return json({ text: '[]' });
};

const page = (id: string, url: string, content: string, terms: string[], informative = 0.8): WebPageGenotype => ({
  id,
  url,
  title: `Title ${id}`,
  content,
  definitions: terms.map((term) => ({ term, description: `${term} is a thoroughly described idea.`, sourceUrl: url })),
  subTopics: [],
  informativeScore: informative,
  authorityScore: 0.8,
  fitness: 0,
});

const population = Array.from({ length: 6 }, (_, i) =>
  page(`gen-${i}`, `https://example${i}.org/a`, `ALPHA-EVIDENCE-MARKER-${i} ` + 'Evidence sentence about the topic. '.repeat(20), [`term${i}a`, `term${i}b`])
);
const searchResult = { sourceMode: 'gemini' as const, generationNote: 'Evidence gathered.', artifacts: { groundingChunks: [] } };

// --- 1. Chapters are written from the gathered evidence, at the new target length, a few at a time ------------------
{
  reset();
  handler = goodHandler;
  const book = await assembleWebBook(population, 'T', searchResult, { mode: 'google_duckduckgo', geminiModel: 'gemini-3.8-flash' });
  assert.equal(book.chapters.length, 10);
  assert.equal(book.sourceMode, 'gemini');
  assert.ok(peakInFlight > 1, 'chapters should still run in parallel');
  assert.ok(peakInFlight <= CHAPTER_CONCURRENCY, `no more than ${CHAPTER_CONCURRENCY} chapter requests in flight (saw ${peakInFlight})`);

  const chapterRequests = requests.filter((r) => /Chapter \d+: /.test(String(r.contents)));
  assert.equal(chapterRequests.length, 10);
  for (const request of chapterRequests) {
    const prompt = String(request.contents);
    assert.ok(prompt.includes('ALPHA-EVIDENCE-MARKER-0'), 'chapter prompt must carry the gathered evidence');
    assert.ok(prompt.includes(`${CHAPTER_TARGET_WORDS.min}-${CHAPTER_TARGET_WORDS.max} words`), 'chapter prompt must ask for the new length');
    assert.ok(request.config.maxOutputTokens >= 8192, 'chapter output must not be capped low enough to truncate it');
  }
  assert.ok(String(requests[0].contents).includes('ALPHA-EVIDENCE-MARKER-5'), 'the outline must see all evidence, not just four sources');
}

// --- 2. One failed chapter no longer discards the others -------------------------------------------------------------
{
  reset();
  handler = (body, ctx) => {
    if (ctx.chapterNumber === 4 || ctx.chapterNumber === 7) {
      return json({ error: { code: 503, status: 'UNAVAILABLE', message: 'overloaded', retriesExhausted: true } }, 503);
    }
    return goodHandler(body, ctx);
  };
  const book = await assembleWebBook(population, 'T', searchResult, { mode: 'google_duckduckgo', geminiModel: 'gemini-3.8-flash' });
  assert.equal(book.chapters.length, 8, 'the 8 good chapters must be kept');
  assert.equal(book.sourceMode, 'gemini');
  assert.match(book.generationNote || '', /8 of 10 chapters were written; 2 could not be generated/);
  assert.match(book.generationNote || '', /left out rather than padded/);
}

// --- 3. A failure that cannot be fixed by retrying stops the run instead of burning requests -------------------------
{
  reset();
  handler = (body, ctx) => {
    if (ctx.chapterNumber != null) {
      return json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', reason: 'quota_daily', message: 'daily quota' } }, 429);
    }
    return goodHandler(body, ctx);
  };
  await assert.rejects(
    assembleWebBook(population, 'T', searchResult, { mode: 'off', geminiModel: 'gemini-3.8-flash' }),
    /daily quota .* used up/i
  );
  // Sibling-model failover may re-ask the same chapter on another model, but no NEW chapters may be started.
  const chaptersAttempted = new Set(requests.map((r) => String(r.contents).match(/Chapter (\d+): /)?.[1]).filter(Boolean));
  assert.ok(
    chaptersAttempted.size <= CHAPTER_CONCURRENCY,
    `a daily-quota failure must stop new chapters (attempted ${chaptersAttempted.size}, in-flight cap ${CHAPTER_CONCURRENCY})`
  );
}

// --- 4. A tiny or empty chapter fails instead of being replaced by canned filler -------------------------------------
{
  reset();
  handler = (body, ctx) => {
    if (ctx.chapterNumber === 2) return json({ text: JSON.stringify({ content: 'Too short.', definitions: [], subTopics: [] }) });
    return goodHandler(body, ctx);
  };
  const book = await assembleWebBook(population, 'T', searchResult, { mode: 'google_duckduckgo', geminiModel: 'gemini-3.8-flash' });
  assert.equal(book.chapters.length, 9);
  assert.ok(book.chapters.every((chapter) => !/Comprehensive exploration of/.test(chapter.content)), 'no canned filler text');
}

// --- 5. evolve() keeps the evidence and applies the redundancy penalty ---------------------------------------------
{
  const subjects = ['Volcanoes erupt molten rock', 'Glaciers carve deep valleys', 'Coral reefs shelter marine fish', 'Monsoon winds bring seasonal rain', 'Tectonic plates slowly collide', 'Rivers deposit fertile silt', 'Deserts store little moisture', 'Forests absorb atmospheric carbon'];
  const many = Array.from({ length: 8 }, (_, i) => page(`gen-${i}`, `https://e${i}.org/p`, `${subjects[i]} across many regions. `.repeat(25), [`t${i}`], 0.9 - i * 0.01));
  const evolved = await evolve(many);
  const originals = evolved.population.filter((p) => !p.id.startsWith('offspring-'));
  assert.ok(originals.length >= 6, `evolve() must keep at least 6 source pages (kept ${originals.length}); it used to keep 1`);

  const a = page('A', 'https://a.org/x', 'Alpha evidence about the topic. '.repeat(10), ['x', 'y'], 0.9);
  const b = page('B', 'https://b.org/x', 'Beta evidence about something else. '.repeat(10), ['x', 'y'], 0.89); // same terms as A
  const c = page('C', 'https://c.org/x', 'Gamma evidence on a third idea. '.repeat(10), ['z'], 0.8);
  const ordered = (await evolve([a, b, c])).population.filter((p) => !p.id.startsWith('offspring-')).map((p) => p.id);
  assert.deepEqual(ordered, ['A', 'C', 'B'], 'a page that repeats already-selected terms must rank below a novel one');

  const duplicate = page('D', 'https://d.org/x', many[0].content, ['t0']);
  const withDuplicate = await evolve([...many, duplicate]);
  assert.ok(!withDuplicate.population.some((p) => p.id === 'D'), 'a verbatim copy of another page is dropped');
}

// --- 6. buildEvidenceDigest respects its budget -----------------------------------------------------------------------
{
  const huge = Array.from({ length: 8 }, (_, i) => page(`h${i}`, `https://h${i}.org`, 'x'.repeat(5000), ['t']));
  assert.ok(buildEvidenceDigest(huge).length <= 12000);
  assert.ok(buildEvidenceDigest(huge.slice(0, 1)).includes('https://h0.org'));
}

// --- 7. Search: an unparseable/empty grounded-JSON answer is recovered with the two-step approach ----------------------
{
  reset();
  const sources = [{
    url: 'https://real.example.org/a', title: 'Real source', content: 'Substantive content about the topic.',
    definitions: [{ term: 'Widget', description: 'A widget is a small mechanical device.' }],
    subTopics: [{ title: 'History', summary: 'How widgets came about.' }], informativeScore: 0.9, authorityScore: 0.9,
  }];
  handler = (body) => {
    const hasSearch = Boolean(body.config?.tools);
    const hasJson = body.config?.responseMimeType === 'application/json';
    if (hasSearch && hasJson) return json({ text: 'ems": [{"url": "https://cut.off' }); // beginning missing: unparseable
    if (hasSearch) {
      return json({
        text: 'Research notes: Real source (https://real.example.org/a) ...',
        candidates: [{ groundingMetadata: { groundingChunks: [{ web: { uri: 'https://real.example.org/a', title: 'Real source' } }] } }],
      });
    }
    return json({ text: JSON.stringify(sources) });
  };
  const result = await searchAndExtract('widgets', { mode: 'off', geminiModel: 'gemini-3.8-flash' });
  assert.equal(result.sourceMode, 'gemini');
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].url, 'https://real.example.org/a');
  assert.equal(requests.length, 3, 'primary call + grounded research + structuring');
  assert.equal(requests[2].config.tools, undefined, 'the structuring call must not use tools');
}

// --- 8. Gemini-only mode reports "no content" honestly (it used to say "could not be reached") ------------------------
{
  reset();
  handler = () => json({ text: '[]' });
  await assert.rejects(
    searchAndExtract('widgets', { mode: 'off', geminiModel: 'gemini-3.8-flash' }),
    /returned no usable sources/
  );
}


// --- 9. Sibling-model failover works, is bounded, and is disclosed in the notice ---------------------------------------
{
  reset();
  handler = (body, ctx) => {
    if (body.model === 'gemini-3.8-flash') {
      return json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', reason: 'quota_daily', message: 'daily quota for this model', retriesExhausted: false } }, 429);
    }
    return goodHandler(body, ctx);
  };
  const book = await assembleWebBook(population, 'T', searchResult, { mode: 'off', geminiModel: 'gemini-3.8-flash' });
  assert.equal(book.chapters.length, 10, 'a sibling model must be able to finish the book');
  assert.match(book.generationNote || '', /were answered by gemini-3\.6-flash instead of the selected gemini-3\.8-flash/);
  assert.ok(new Set(requests.map((r) => r.model)).size <= 3, 'at most the selected model plus two siblings are ever tried');
}

// An error that is identical on every model (bad key) is NOT retried on siblings.
{
  reset();
  handler = () => json({ error: { code: 403, status: 'PERMISSION_DENIED', reason: 'permission_denied', message: 'key leaked' } }, 403);
  await assert.rejects(
    searchAndExtract('widgets', { mode: 'off', geminiModel: 'gemini-3.8-flash' }),
    /HTTP 403/
  );
  assert.equal(requests.length, 1, 'a 403 must cost exactly one request: no sibling failover, no knowledge-synthesis attempt');
}

// --- 10. Knowledge synthesis: only when it can help, never with invented URLs, always labelled -------------------------
{
  reset();
  const perspectives = [{
    title: 'Overview', content: 'A long summary written from the model\'s own knowledge. '.repeat(10),
    definitions: [{ term: 'Widget', description: 'A widget is a small mechanical device.' }],
    subTopics: [{ title: 'History', summary: 'How widgets came about.' }], informativeScore: 0.8, authorityScore: 0.7,
  }];
  handler = (body) => {
    if (body.config?.tools) {
      return json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', reason: 'rate_limited', message: 'grounding quota', retriesExhausted: true } }, 429);
    }
    return json({ text: JSON.stringify(perspectives) });
  };
  const result = await searchAndExtract('widgets', { mode: 'off', geminiModel: 'gemini-3.8-flash' });
  assert.equal(result.sourceMode, 'model_knowledge', 'model memory must not be labelled as grounded research');
  assert.ok(result.results.every((r) => r.url === ''), 'no invented URLs');
  assert.ok(result.results.every((r) => r.definitions.every((d) => d.sourceUrl === '')));
  assert.match(result.generationNote || '', /NOT verified against live web sources/);
  const knowledgeRequest = requests.find((r) => !r.config?.tools);
  assert.ok(!/https?:\/\/|URL/i.test(JSON.stringify(knowledgeRequest.config.responseSchema.items.properties)) , 'the schema must not ask for a url');
}

// A rejected key never triggers a knowledge-synthesis request (it would fail the same way).
{
  reset();
  handler = () => json({ error: { code: 401, status: 'UNAUTHENTICATED', reason: 'invalid_api_key', message: 'API key not valid' } }, 401);
  await assert.rejects(searchAndExtract('widgets', { mode: 'off', geminiModel: 'gemini-3.8-flash' }), /rejected by Google/);
  assert.equal(requests.length, 1);
}

// --- 9. A model that times out is failed over to the fast sibling, and is asked only once ----------------------------
{
  reset();
  handler = (body, ctx) => {
    if (body.model === 'gemini-3.8-flash') {
      return json({ error: { code: 504, status: undefined, reason: 'timeout', message: 'slow', retriesExhausted: true } }, 504);
    }
    return goodHandler(body, ctx);
  };
  const book = await assembleWebBook(population, 'T', searchResult, { mode: 'off', geminiModel: 'gemini-3.8-flash' });
  assert.equal(book.chapters.length, 10);
  const slowRequests = requests.filter((r) => r.model === 'gemini-3.8-flash');
  assert.ok(slowRequests.length <= 60, `the slow model is asked without infinite looping (asked ${slowRequests.length} times)`);
  assert.ok(requests.some((r) => r.model === 'gemini-3.6-flash'), 'the fast sibling must serve the requests');
  assert.match(book.generationNote || '', /gemini-3\.6-flash instead of the selected gemini-3\.8-flash/);
}

console.log('assembleWebBook tests passed');
