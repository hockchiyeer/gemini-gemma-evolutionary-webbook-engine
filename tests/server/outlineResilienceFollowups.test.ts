import assert from 'node:assert/strict';
import {
  assembleWebBook,
  buildEvidenceOutline,
  cleanSourceTitle,
  synthesizeFallbackWebBook,
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
const page = (id: string, url: string, title: string, content: string): WebPageGenotype => ({
  id, url, title, content, definitions: [], subTopics: [], informativeScore: 0.8, authorityScore: 0.8, fitness: 0,
});

// --- 1. Wikipedia taglines are site names in both scripts ------------------------------------------------------------
{
  const url = 'https://zh.wikipedia.org/wiki/x';
  assert.equal(cleanSourceTitle('新謠 - 維基百科，自由的百科全書', url), '新謠');
  assert.equal(cleanSourceTitle('新谣 - 维基百科，自由的百科全书', url), '新谣');
}

// --- 2. Evidence outline: needs two sources, uses the page's own sentence, no canned English or topic-as-term --------
{
  const topic = '新加坡歌谣';
  const a = page('a', 'https://a.org/x', '新谣的兴起 - 站点甲', '新谣是一种音乐流派。它兴起于八十年代。');
  const b = page('b', 'https://b.org/y', '海蝶音乐的成立 - 站点乙', '海蝶音乐成立于1986年。它推出了许多歌手。');
  assert.deepEqual(buildEvidenceOutline(topic, [a]), [], 'one source is not an outline');
  const outline = buildEvidenceOutline(topic, [a, b]);
  assert.equal(outline.length, 2);
  assert.equal(outline[0].focus, '新谣是一种音乐流派。');
  for (const entry of outline) {
    assert.ok(!/In-depth analysis|Investigation into|Exploration of/.test(entry.focus), 'no English template in a Chinese book');
    assert.ok(!entry.terms.includes(topic), 'the book topic is not a chapter term');
  }
}

// --- 3. An English topic with one Chinese word keeps its English evidence ---------------------------------------------
{
  const en = 'Xinyao is a genre of songs originating from Singapore. It emerged in Singapore between the late 1970s and 1980s. Recurring themes include friendships and school life.';
  const zh = '新谣是一种源自新加坡的音乐流派。创作者通常为年轻音乐人。其作品配乐简单旋律流畅。同年九月研讨会探讨了校园民谣兴起。';
  const book = synthesizeFallbackWebBook('What is 新谣?', [page('a', 'https://zh.example.org/a', '新谣', zh), page('b', 'https://en.example.org/b', 'Xinyao', en)]);
  assert.match(book.chapters.map((c) => c.content).join(' '), /Xinyao is a genre/);
  assert.ok(!/non-Chinese sentences were left out/.test(book.generationNote || ''));
}

// --- 4. Daily quota at the outline stage: no 6-chapter retry in the normal (non Gemini-only) mode ---------------------
{
  let outlineRequests: string[] = [];
  globals.fetch = async (_input: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (body.config?.responseSchema?.properties?.outline) {
      outlineRequests.push(String(body.contents).match(/exactly (\d+) chapters/)?.[1] ?? '?');
      return json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', reason: 'quota_daily', message: 'daily quota' } }, 429);
    }
    return json({ text: '[]' });
  };
  const pages = ['新谣的兴起', '海蝶音乐的成立', '新谣节', '电视剧歌曲'].map((t, i) =>
    page(`p${i}`, `https://site${i}.org/a`, `${t} - 站点${i}`, `${t}是一段完整的说明，包含若干具体事实与背景介绍，并且足够长以便写成章节。`.repeat(4)));
  const book = await assembleWebBook(pages, '新加坡歌谣', { sourceMode: 'gemini' as const, generationNote: 'Evidence gathered.', artifacts: { groundingChunks: [] } }, { mode: 'google_duckduckgo', geminiModel: 'gemini-3.8-flash' });
  assert.ok(outlineRequests.length > 0 && outlineRequests.every((n) => n === '10'), `only 10-chapter outline requests were sent (saw ${outlineRequests.join(',')})`);
  assert.notEqual(book.sourceMode, 'gemini', 'falls back to the offline book');
}

console.log('outlineResilienceFollowups tests passed');
