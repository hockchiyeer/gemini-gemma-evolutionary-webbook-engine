import assert from 'node:assert/strict';
import { buildGoogleSearchFallbackPayload } from '../../server/googleSearchFallback.ts';
import { assembleWebBook, searchAndExtract } from '../../src/services/evolutionService.ts';
import {
  describeFallbackEvidence,
  getFallbackResultCount,
  isSyntheticFallbackPayload,
} from '../../src/services/searchFallbackShared.ts';
import type { SearchFallbackMode, SearchFallbackPayload } from '../../src/types.ts';

process.env.GEMINI_API_KEY = 'test-key';
const globals = globalThis as unknown as Record<string, unknown>;
globals.window = { location: { origin: 'http://localhost:3000', href: 'http://localhost:3000/' } };
const realSetTimeout = globalThis.setTimeout;
globals.setTimeout = ((handler: () => void) => realSetTimeout(handler, 0)) as unknown as typeof setTimeout;
console.warn = () => {};
console.error = () => {};

const QUERY = 'Which candidate will win the Taipei mayor election due on Nov 2026?';
const MODEL = 'gemini-3-flash-preview';

const GOOGLE_BLOCKED = '<html><body>Our systems have detected unusual traffic from your computer network. captcha</body></html>';
const GOOGLE_OK = `<html><body>
<a href="https://news.example.org/taipei-race"><h3>Taipei mayoral race: candidates and polls</h3></a>
<div class="VwiC3b">The Taipei mayoral race features several declared candidates, and recent polls show a tight contest.</div>
<a href="https://wiki.example.org/taipei-election"><h3>2026 Taipei mayoral election overview</h3></a>
<div class="VwiC3b">An overview of the 2026 Taipei mayoral election, its candidates, parties and voting rules.</div>
</body></html>`;
const DDG_OK = `<html><body>
<a class="result__a" href="https://ddg-source.example.net/a">Taipei election analysis from DDG</a>
<a class="result__snippet">Analysis of the Taipei mayoral election with polling averages and candidate backgrounds.</a>
<a class="result__a" href="https://ddg-other.example.net/b">Taipei candidate profiles from DDG</a>
<a class="result__snippet">Profiles of the Taipei mayoral candidates including party platforms and past records.</a>
</body></html>`;
const EMPTY = '<html><body>nothing</body></html>';

type Scenario = { google: 'ok' | 'blocked' | 'empty'; ddg: 'ok' | 'empty'; gemini: 429 | 401 | 200 | 404 | 'search_ok_then_503' };
let scenario: Scenario = { google: 'ok', ddg: 'ok', gemini: 429 };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html' } });

globals.fetch = async (input: unknown, init?: { body?: unknown }) => {
  const url = new URL(typeof input === 'string' ? input : (input as { url?: string }).url ?? String(input));
  if (url.hostname === 'localhost' && url.pathname.startsWith('/api/gemini')) {
    if (scenario.gemini === 429) return json({ error: { code: 429, message: 'You exceeded your current quota', status: 'RESOURCE_EXHAUSTED' } }, 429);
    if (scenario.gemini === 404) return json({ error: { code: 404, message: 'models/x is not found', status: 'NOT_FOUND' } }, 404);
    if (scenario.gemini === 'search_ok_then_503') {
      const isSearch = String(init?.body ?? '').includes('googleSearch');
      if (isSearch) {
        const sources = [{ url: 'https://g.example.org/a', title: 'A', content: 'Alpha content', definitions: [], subTopics: [], informativeScore: 0.8, authorityScore: 0.8 }];
        return json({ text: JSON.stringify(sources), candidates: [{ content: { parts: [{ text: JSON.stringify(sources) }] } }] });
      }
      return json({ error: { code: 503, message: 'The service is unavailable', status: 'UNAVAILABLE' } }, 503);
    }
    if (scenario.gemini === 401) return json({ error: { code: 401, message: 'API key not valid', status: 'UNAUTHENTICATED' } }, 401);
    return json({ text: '[]', candidates: [{ content: { parts: [{ text: '[]' }] } }] });
  }
  if (url.hostname === 'localhost') {
    let query = url.searchParams.get('query');
    let mode = url.searchParams.get('mode') as SearchFallbackMode;
    if (!query && init?.body) {
      try {
        const parsed = JSON.parse(String(init.body));
        query = parsed.query;
        mode = parsed.mode;
      } catch {}
    }
    const payload = await buildGoogleSearchFallbackPayload(query!, mode);
    return json(payload);
  }
  if (url.hostname.endsWith('googleapis.com')) {
    if (scenario.gemini === 429) return json({ error: { code: 429, message: 'You exceeded your current quota', status: 'RESOURCE_EXHAUSTED' } }, 429);
    if (scenario.gemini === 404) return json({ error: { code: 404, message: 'models/x is not found', status: 'NOT_FOUND' } }, 404);
    if (scenario.gemini === 'search_ok_then_503') {
      const isSearch = String(init?.body ?? '').includes('googleSearch');
      if (isSearch) {
        const sources = [{ url: 'https://g.example.org/a', title: 'A', content: 'Alpha content', definitions: [], subTopics: [], informativeScore: 0.8, authorityScore: 0.8 }];
        return json({ text: JSON.stringify(sources), candidates: [{ content: { parts: [{ text: JSON.stringify(sources) }] } }] });
      }
      return json({ error: { code: 503, message: 'The service is unavailable', status: 'UNAVAILABLE' } }, 503);
    }
    if (scenario.gemini === 401) return json({ error: { code: 401, message: 'API key not valid', status: 'UNAUTHENTICATED' } }, 401);
    return json({ text: '[]', candidates: [{ content: { parts: [{ text: '[]' }] } }] });
  }
  if (url.hostname.includes('google.com')) {
    return html(scenario.google === 'ok' ? GOOGLE_OK : scenario.google === 'blocked' ? GOOGLE_BLOCKED : EMPTY);
  }
  if (url.hostname === 'api.duckduckgo.com') return json({});
  if (url.hostname.includes('duckduckgo.com')) return html(scenario.ddg === 'ok' ? DDG_OK : EMPTY);
  return html(EMPTY, 404);
};

async function run(next: Scenario, mode: SearchFallbackMode = 'google_duckduckgo') {
  scenario = next;
  return searchAndExtract(QUERY, { mode, geminiModel: MODEL });
}

async function stopMessage(next: Scenario, mode: SearchFallbackMode = 'google_duckduckgo'): Promise<string> {
  try {
    await run(next, mode);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  assert.fail('Expected searchAndExtract to stop with an error');
}

// A. Both providers contributed -> notice names both, source reflects both.
{
  const result = await run({ google: 'ok', ddg: 'ok', gemini: 429 });
  assert.equal(
    result.generationNote,
    `Selected Gemini model: ${MODEL} unavailable (usage limit reached); gathered evidence via Google fallback + DuckDuckGo fallback.`
  );
  assert.equal(result.fallbackSource, 'google_duckduckgo');
  assert.equal(result.fallbackReason, 'quota_exhausted');
  assert.equal(result.sourceMode, 'fallback_search');
  assert.ok(result.results.length >= 4);
}

// B. Google blocked -> DuckDuckGo only, and the notice says Google was tried but contributed nothing.
{
  const result = await run({ google: 'blocked', ddg: 'ok', gemini: 429 });
  assert.equal(
    result.generationNote,
    `Selected Gemini model: ${MODEL} unavailable (usage limit reached); gathered evidence via DuckDuckGo fallback (Google contributed no results).`
  );
  assert.equal(result.fallbackSource, 'duckduckgo');
}

// C. Neither provider returned anything -> graceful stop (no placeholder book), with retry/refine guidance.
{
  const message = await stopMessage({ google: 'empty', ddg: 'empty', gemini: 429 });
  assert.match(message, /^Search stopped: The Google and DuckDuckGo fallback searches returned no live results/);
  assert.ok(message.includes(QUERY), 'message keeps the exact query so the user can see what was searched');
  assert.match(message, /Search again with the same wording/);
  assert.match(message, /Refine the wording/);
  assert.match(message, /No Web-book was generated/);
  assert.doesNotMatch(message, /wikipedia/i);
  // useWebBookEngine rewrites messages containing quota/429/RESOURCE_EXHAUSTED unless this phrase is present.
  assert.ok(message.includes('no external evidence could be gathered'));
  assert.doesNotMatch(message, /quota|RESOURCE_EXHAUSTED/i);
}

// C2. Same graceful stop for single-provider modes, with accurate provider naming.
{
  assert.match(await stopMessage({ google: 'empty', ddg: 'empty', gemini: 429 }, 'google'), /^Search stopped: The Google fallback search returned no live results/);
  assert.match(await stopMessage({ google: 'empty', ddg: 'empty', gemini: 429 }, 'duckduckgo'), /^Search stopped: The DuckDuckGo fallback search returned no live results/);
}

// D. Not a quota problem -> the notice and reason say so instead of claiming quota exhaustion.
{
  const result = await run({ google: 'blocked', ddg: 'ok', gemini: 401 });
  assert.match(result.generationNote || '', /unavailable \(API key rejected\)/);
  assert.notEqual(result.fallbackReason, 'quota_exhausted');
}

// E. Gemini answered without error but produced no usable sources.
{
  const result = await run({ google: 'ok', ddg: 'ok', gemini: 200 });
  assert.match(result.generationNote || '', /unavailable \(no usable sources returned\)/);
  assert.equal(result.fallbackReason, 'no_content');
}

// F. Gemini-only mode keeps its existing user-facing error (no fallback involved).
{
  const message = await stopMessage({ google: 'ok', ddg: 'ok', gemini: 429 }, 'off');
  assert.match(message, /^Gemini is currently busy or rate-limited/);
}

// G. The server's placeholder payload is detectable, and real payloads never are.
{
  scenario = { google: 'empty', ddg: 'empty', gemini: 429 };
  const synthetic = await buildGoogleSearchFallbackPayload(QUERY, 'google_duckduckgo');
  assert.equal(isSyntheticFallbackPayload(synthetic), true);
  scenario = { google: 'ok', ddg: 'ok', gemini: 429 };
  assert.equal(isSyntheticFallbackPayload(await buildGoogleSearchFallbackPayload(QUERY, 'google_duckduckgo')), false);
  assert.equal(isSyntheticFallbackPayload(undefined), false);
}

// H. DuckDuckGo evidence delivered via the Lite or Instant Answer endpoints is recognised (HTML count may be 0).
{
  const base = { query: 'q', provider: 'duckduckgo', results: [{ title: 't', url: 'https://example.com', snippet: 's' }] } as SearchFallbackPayload;
  const liteOnly = { ...base, diagnostics: ['duckduckgo-html-q1:200', 'duckduckgo-results:0', 'duckduckgo-lite-q1:200', 'duckduckgo-lite-results:3'] };
  assert.equal(getFallbackResultCount(liteOnly, 'duckduckgo'), 3);
  assert.equal(describeFallbackEvidence(liteOnly, 'google_duckduckgo').source, 'duckduckgo');
  const instantOnly = { ...base, diagnostics: ['duckduckgo-results:0', 'duckduckgo-instant-results:2'] };
  assert.equal(getFallbackResultCount(instantOnly, 'duckduckgo'), 2);
  // Payloads without per-provider diagnostics (e.g. the Cypress fixtures) fall back to the declared provider.
  const fixtureShape = { ...base, provider: 'google', diagnostics: ['provider:google', 'result-count:8'] } as SearchFallbackPayload;
  assert.equal(describeFallbackEvidence(fixtureShape, 'google_duckduckgo').label, 'Google fallback (DuckDuckGo contributed no results)');
  assert.equal(describeFallbackEvidence({ ...base, diagnostics: undefined }, 'duckduckgo').label, 'DuckDuckGo fallback');
}

// I. Selected model not found -> never swapped silently; reported as the cause (fallback) or as an error (off).
{
  const result = await run({ google: 'ok', ddg: 'ok', gemini: 404 });
  assert.match(result.generationNote || '', new RegExp(`Selected Gemini model: ${MODEL} unavailable \\(model not available\\)`));
  assert.equal(result.sourceMode, 'fallback_search');
  assert.match(await stopMessage({ google: 'ok', ddg: 'ok', gemini: 404 }, 'off'), /is not available/);
}

// J. Gemini search succeeds but book assembly fails: the notice must not claim Gemini synthesized the book.
{
  const q = QUERY;
  const search = async (mode: SearchFallbackMode) => {
    scenario = { google: 'ok', ddg: 'ok', gemini: 'search_ok_then_503' };
    return searchAndExtract(q, { mode, geminiModel: MODEL });
  };
  for (const mode of ['google_duckduckgo', 'google', 'duckduckgo'] as SearchFallbackMode[]) {
    const found = await search(mode);
    assert.equal(found.sourceMode, 'gemini');
    assert.match(found.generationNote || '', /Evidence gathered via Google Search grounding/);
    const book = await assembleWebBook(found.results, q, found, { mode, geminiModel: MODEL });
    assert.equal(book.sourceMode, 'hybrid');
    assert.match(book.generationNote || '', /unavailable for book assembly \(service temporarily unavailable\); book text assembled offline/);
    assert.doesNotMatch(book.generationNote || '', /Synthesized from Google Search grounding via Gemini/);
  }
  const found = await search('off');
  await assert.rejects(assembleWebBook(found.results, q, found, { mode: 'off', geminiModel: MODEL }), /Gemini is temporarily unavailable/);
}

// K. Resilient fallback book synthesis contains distinct, deduplicated chapters and no boilerplate or URL slugs.
{
  scenario = { google: 'ok', ddg: 'ok', gemini: 429 };
  const fallbackRes = await searchAndExtract(QUERY, { mode: 'google_duckduckgo', geminiModel: MODEL });
  const book = await assembleWebBook(fallbackRes.results, QUERY, fallbackRes, { mode: 'google_duckduckgo', geminiModel: MODEL });
  // Four one-sentence snippets are too little for several chapters: they make one chapter (chapters need four or more sentences), not four captions.
  assert.equal(book.chapters.length, 1);

  const seenTitles = new Set<string>();
  const seenContent = new Set<string>();
  const allDefTerms = new Set<string>();
  const allSubTitles = new Set<string>();

  for (const ch of book.chapters) {
    // Unique chapter titles and content
    assert.ok(!seenTitles.has(ch.title), `Duplicate chapter title: ${ch.title}`);
    seenTitles.add(ch.title);
    assert.ok(!seenContent.has(ch.content), `Duplicate chapter content detected`);
    seenContent.add(ch.content);

    // No boilerplate filler
    assert.doesNotMatch(ch.content, /represents a transformative discipline/i);
    assert.doesNotMatch(ch.content, /Inquiring into authoritative evidence on/i);

    // No leaked URL fragments or Concept placeholder terms in definitions
    for (const def of ch.definitions) {
      assert.doesNotMatch(def.term, /^Concept\s*\d*$/i, `Placeholder term detected: ${def.term}`);
      assert.doesNotMatch(def.description, /https?:\/\//i, `Raw URL detected in definition: ${def.description}`);
      assert.doesNotMatch(def.description, /^[a-z0-9_-]+\/[a-z0-9_-]+/i, `URL path slug detected in definition: ${def.description}`);
      assert.ok(!allDefTerms.has(def.term.toLowerCase()), `Duplicate definition term across chapters: ${def.term}`);
      allDefTerms.add(def.term.toLowerCase());
    }

    // No duplicated subtopics across chapters
    for (const st of ch.subTopics) {
      assert.ok(!allSubTitles.has(st.title.toLowerCase()), `Duplicate subtopic across chapters: ${st.title}`);
      allSubTitles.add(st.title.toLowerCase());
    }
  }
}

console.log('fallbackNotice regression tests passed');
