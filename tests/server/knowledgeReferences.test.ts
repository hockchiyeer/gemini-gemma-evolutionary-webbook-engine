import assert from 'node:assert/strict';
import {
  assembleWebBook,
  attachKnowledgeReferences,
  buildReferenceSearchLinks,
  KNOWLEDGE_REFERENCES_PER_CHAPTER,
} from '../../src/services/evolutionService.ts';
import { SYNTHETIC_FALLBACK_DIAGNOSTIC } from '../../src/services/searchFallbackShared.ts';
import type { Chapter, SearchFallbackPayload, WebBook, WebPageGenotype } from '../../src/types.ts';

const globals = globalThis as unknown as Record<string, unknown>;
globals.window = { location: { origin: 'http://localhost:3000', href: 'http://localhost:3000/' } };
const realSetTimeout = globalThis.setTimeout;
globals.setTimeout = ((handler: () => void) => realSetTimeout(handler, 0)) as unknown as typeof setTimeout;
console.warn = () => {};
console.error = () => {};

const TOPIC =
  "AI's biggest drivers and sources of revenue are cloud infrastructure, cloud services, energy, real estate, semiconductors, AI chips, and hardware peripherals, networking and cooling systems";
const chapter = (n: number, sourceUrls: Chapter['sourceUrls'] = []): Chapter => ({
  title: `Chapter ${n} title`,
  content: 'Some chapter text. '.repeat(20),
  definitions: [{ term: `Term ${n}`, description: 'A described term.', sourceUrl: '' }],
  subTopics: [],
  sourceUrls,
  visualSeed: `seed ${n}`,
});
const knowledgeBook = (count = 4): WebBook => ({
  id: 'b',
  topic: TOPIC,
  timestamp: 1_700_000_000_000,
  chapters: Array.from({ length: count }, (_, i) => chapter(i + 1)),
  sourceMode: 'model_knowledge',
  generationNote: 'Synthesized via Gemini knowledge synthesis model: m; NOT verified against live web sources.',
});
const payload = (urls: string[], extra: Partial<SearchFallbackPayload> = {}): SearchFallbackPayload => ({
  query: 'q',
  provider: 'duckduckgo',
  results: urls.map((url, i) => ({ title: `Result ${i}`, url, snippet: 's' })),
  ...extra,
});

// 1. Search links are built from a short, whole-word query and are plain search URLs
{
  const links = buildReferenceSearchLinks(TOPIC, 'Cooling Systems');
  assert.equal(links.length, 2);
  assert.ok(links.every((l) => /^https:\/\//.test(l.url)));
  assert.ok(links[0].url.startsWith('https://en.wikipedia.org/w/index.php?search='));
  assert.ok(links[1].url.startsWith('https://scholar.google.com/scholar?q='));
  assert.ok(decodeURIComponent(links[0].url).length < 200, 'the query stays short');
  assert.ok(!decodeURIComponent(links[0].url).endsWith('…'), 'no ellipsis inside a search query');
  assert.ok(links[0].title.startsWith('Wikipedia search:'), 'labelled as a search, not a source');
  assert.ok(buildReferenceSearchLinks('台北市長選舉', '第一章')[0].url.startsWith('https://zh.wikipedia.org/'));
}

// 1b. Numbering the model put in the title is dropped, and a descriptive title is searched on its own
{
  const decoded = (title: string) => decodeURIComponent(buildReferenceSearchLinks(TOPIC, title)[0].url.split('search=')[1]);
  assert.equal(decoded('Chapter 1: Cloud Infrastructure and Datacenter Dynamics'), 'Cloud Infrastructure and Datacenter Dynamics');
  assert.equal(decoded('CHAPTER 12 - Semiconductor Fab Capacity and Memory Constraints'), 'Semiconductor Fab Capacity and Memory Constraints');
  assert.equal(decoded('3. Hyperscale Cloud Infrastructure: The New Utility'), 'Hyperscale Cloud Infrastructure: The New Utility');
  assert.equal(decoded('第一章：浴室里的冷笑与荒诞序幕'), '浴室里的冷笑与荒诞序幕');
  const generic = decoded('Chapter 6: Future Outlook');
  assert.ok(generic.endsWith('Future Outlook') && generic.length > 'Future Outlook'.length, 'a generic title keeps topic context');
  assert.equal(generic, 'AI\'s biggest drivers and sources of revenue are cloud infrastructure, cloud services Future Outlook', 'topic context ends on a clause, not mid-phrase');
  assert.ok(generic.length <= 120, 'topic context is short');
  assert.ok(!/chapter\s*\d/i.test(generic));
}

// 2. Live results are attached per chapter, deduplicated across chapters, capped, and never search-engine pages
{
  const queries: string[] = [];
  const book = await attachKnowledgeReferences(knowledgeBook(), { mode: 'google_duckduckgo' }, async (query) => {
    queries.push(query);
    return payload([
      'https://example.com/shared',
      'https://www.google.com/search?q=x',
      'https://duckduckgo.com/?q=x',
      `https://example.org/${queries.length}/a`,
      `https://example.org/${queries.length}/b`,
      `https://example.org/${queries.length}/c`,
    ]);
  });
  assert.equal(queries.length, 4, 'one short lookup per chapter');
  assert.ok(queries.every((q) => q.length < 140), 'queries are shortened, not the whole 180-character topic');
  const all = book.chapters.flatMap((c) => c.sourceUrls.map((s) => (typeof s === 'string' ? s : s.url)));
  assert.ok(book.chapters.every((c) => c.sourceUrls.length >= 1 && c.sourceUrls.length <= KNOWLEDGE_REFERENCES_PER_CHAPTER));
  assert.ok(all.every((u) => !/google\.com\/search|duckduckgo\.com/.test(u)), 'search-engine result pages are not references');
  assert.equal(all.filter((u) => u === 'https://example.com/shared').length, 1, 'a page is listed once across the book');
  assert.match(book.generationNote || '', /NOT verified against live web sources/, 'the original notice stays');
  assert.match(book.generationNote || '', /not used to write the text/, 'live links are described as related pages');
  assert.equal(book.sourceMode, 'model_knowledge');
}

// 3. An unreachable search stops after the first failure and every chapter still gets search links
{
  let calls = 0;
  const book = await attachKnowledgeReferences(knowledgeBook(6), { mode: 'google_duckduckgo' }, async () => {
    calls += 1;
    throw new Error('search unavailable');
  });
  assert.ok(calls <= 3, `lookups stop once search is unreachable (saw ${calls})`);
  assert.ok(book.chapters.every((c) => c.sourceUrls.length === 2), 'every chapter gets search links');
  assert.match(book.generationNote || '', /search links .*not cited sources/);
}

// 4. Synthetic placeholder payloads are not references; Gemini-only mode makes no search request at all
{
  const synthetic = await attachKnowledgeReferences(
    knowledgeBook(2),
    { mode: 'google_duckduckgo' },
    async () => payload(['https://en.wikipedia.org/wiki/Fake'], { diagnostics: [SYNTHETIC_FALLBACK_DIAGNOSTIC] })
  );
  assert.ok(synthetic.chapters.every((c) => c.sourceUrls.some((s) => typeof s !== 'string' && s.url.includes('scholar.google.com'))));

  let called = false;
  const off = await attachKnowledgeReferences(knowledgeBook(2), { mode: 'off' }, async () => {
    called = true;
    return payload(['https://example.com']);
  });
  assert.equal(called, false, 'mode "off" never contacts Google or DuckDuckGo');
  assert.ok(off.chapters.every((c) => c.sourceUrls.length === 2));
}

// 5. Chapters that already have sources are left alone
{
  const book = knowledgeBook(2);
  book.chapters[0] = chapter(1, [{ title: 'Kept', url: 'https://kept.example/' }]);
  const out = await attachKnowledgeReferences(book, { mode: 'off' });
  assert.deepEqual(out.chapters[0].sourceUrls, [{ title: 'Kept', url: 'https://kept.example/' }]);
  assert.equal(out.chapters[1].sourceUrls.length, 2);
  const untouched = await attachKnowledgeReferences({ ...book, chapters: [out.chapters[0]] }, { mode: 'off' });
  assert.equal(untouched.generationNote, book.generationNote, 'nothing to add, nothing to say');
}

// 6. End to end: a model-knowledge run through assembleWebBook ends with references in every chapter
{
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const outline = Array.from({ length: 3 }, (_, i) => ({
    title: `Outline chapter ${i + 1}`, focus: 'Focus one. Focus two.', terms: ['a', 'b', 'c', 'd'], subTopicTitles: ['x', 'y', 'z'], visualSeed: `s${i}`,
  }));
  const prompts: string[] = [];
  globals.fetch = async (input: unknown, init?: { body?: unknown }) => {
    const url = new URL(typeof input === 'string' ? input : (input as { url?: string }).url ?? String(input));
    if (url.pathname === '/api/search-fallback') {
      return json(payload([`https://news.example/${encodeURIComponent(url.searchParams.get('query') || '')}`]));
    }
    const body = JSON.parse(String(init?.body ?? '{}'));
    prompts.push(String(body.contents));
    if (body.config?.responseSchema?.properties?.outline) return json({ text: JSON.stringify({ topic: 'T', outline }) });
    const n = Number(String(body.contents).match(/Chapter (\d+): /)?.[1]);
    return json({ text: JSON.stringify({
      content: Array.from({ length: 160 }, (_, i) => `word${n}x${i}`).join(' ') + '.',
      definitions: [{ term: `Term ${n}`, description: 'A clear description of this term in context.' }],
      subTopics: [{ title: `Angle ${n}`, summary: 'A short analysis of this angle on the topic.' }],
    }) });
  };
  const pages: WebPageGenotype[] = [{
    id: 'gen-0', url: '', title: 'Perspective', content: 'Knowledge text. '.repeat(30),
    definitions: [], subTopics: [], informativeScore: 0.9, authorityScore: 0.9, fitness: 0,
  }];
  const book = await assembleWebBook(pages, TOPIC, { sourceMode: 'model_knowledge', generationNote: 'Synthesized via Gemini knowledge synthesis model: m; NOT verified against live web sources.', artifacts: {} }, { mode: 'google_duckduckgo', geminiModel: 'gemini-3.8-flash' });
  assert.equal(book.sourceMode, 'model_knowledge');
  assert.equal(book.chapters.length, 3);
  assert.ok(book.chapters.every((c) => c.sourceUrls.length > 0), 'no chapter is left without references');
  assert.ok(prompts.every((p) => !p.includes('gathered from live sources')), 'knowledge-mode prompts do not claim live sources');
  assert.ok(prompts.some((p) => p.includes("model's own knowledge")));
}

console.log('knowledgeReferences tests passed');
