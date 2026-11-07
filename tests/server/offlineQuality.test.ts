import assert from 'node:assert/strict';
import {
  cleanSourceTitle,
  extractDefinitionsFromSentences,
  isPlausibleChineseTerm,
  leadSentenceTitle,
  synthesizeFallbackWebBook,
} from '../../src/services/evolutionService.ts';
import { normalizeCjkSpacing, stripSnippetSplices } from '../../src/services/searchFallbackShared.ts';
import { getExecutiveOverview } from '../../src/services/printFriendlyReportExport.ts';
import { getExportLabelsForLocale } from '../../src/services/exportLabels.ts';
import type { WebBook } from '../../src/types.ts';

// Regressions found in a real offline (no Gemini key) Chinese book: junk glossary terms cut from the middle of sentences,
// search-snippet splices ("没 ... 为了组成政府"), blanks inside Chinese text that hid duplicates, headings taken from section
// labels / citations / "PDF" markers, and an English diagnostic as the abstract of a Chinese book.

// 1. Glossary: the first 是 / 为 of a sentence is not a term / definition boundary.
{
  const junk = [
    '这不仅是政策制定者的难题，也关乎每一位大马百姓的生计。',
    '本期文章将为您深度拆解大马能源体系的两大核心支柱，探寻其背后的真实数据。',
    '马来西亚的石油储存并不是一个单一的巨大油库，而是一个由国家石油公司主导的复杂物理网络。',
    '这证明了安华当时是认为全国免费教育可行，并不会为国家带来巨大的负担。',
  ];
  assert.deepEqual(extractDefinitionsFromSentences(junk, 'https://example.org/a'), [], 'clause openings are not terms');
  for (const term of ['这不仅', '本期文章将', '马来西亚的石油储存并不', '这证明了安华当时']) {
    assert.equal(isPlausibleChineseTerm(term), false, term);
  }

  // Ordinary nouns that end in the same characters as clause fragments are still terms.
  for (const term of ['马大华文学会', '人才', '成就', '首都', '功能', '供应链', '团结政府', '就业市场', '了解中心']) {
    assert.equal(isPlausibleChineseTerm(term), true, term);
  }

  const real = extractDefinitionsFromSentences(
    ['安华是马来西亚第十任首相，曾长期担任反对党领袖并推动多项改革。', '燃油补贴制度是指政府为压低油价而长期提供的财政补助安排。'],
    'https://example.org/b',
  );
  assert.deepEqual(real.map((d) => d.term), ['安华', '燃油补贴制度']);
}

// 2. Snippet splices are cut back to complete sentences; ordinary text is untouched.
{
  const spliced = '柔佛州选，国阵大胜；首相任期限制法案受阻。团结政府 同床异梦？2022年，第15届全国大选后，没 ... 为了组成政府，五大政治联盟、19个政党共同执政，组成了马来西亚史上最复杂的联合政府。';
  const cleaned = normalizeCjkSpacing(stripSnippetSplices(spliced));
  assert.equal(cleaned, '柔佛州选，国阵大胜；首相任期限制法案受阻。团结政府同床异梦？');
  assert.equal(stripSnippetSplices('马来西亚政治转型具有一定特殊性。2018 年大选后，希望联盟上台 ...'), '马来西亚政治转型具有一定特殊性。');
  assert.equal(stripSnippetSplices('He said... nothing. Costs rose 3.2% last year. Really ... more later'), 'He said... nothing. Costs rose 3.2% last year.');
  const plain = '没有任何一方能够单独执政。这是事实。';
  assert.equal(stripSnippetSplices(plain), plain);
  assert.equal(normalizeCjkSpacing('国油 资源 分配 with Petronas 的 补贴'), '国油资源分配 with Petronas 的补贴');
}

// 3. Headings.
{
  const url = 'https://www.malaysiakini.com/news/1';
  assert.equal(cleanSourceTitle('PDF 马来西亚政治转型困境的动因及其前景', 'https://niis.cssn.cn/x'), '马来西亚政治转型困境的动因及其前景');
  assert.equal(cleanSourceTitle('[PDF] Malaysia Political Transition', 'https://niis.cssn.cn/x'), 'Malaysia Political Transition');
  assert.equal(cleanSourceTitle('文告 | 马大新青年对削减富人教育津贴的三大疑问', url), '马大新青年对削减富人教育津贴的三大疑问');
  assert.equal(cleanSourceTitle('焦点', url), '');
  assert.equal(cleanSourceTitle('文告', url), '');
  assert.equal(cleanSourceTitle('Home | Real Page Title', url), 'Real Page Title');

  const lead = leadSentenceTitle('（来源：S&P Global Commodity Insights）但结构性趋势难以在短期内逆转，《世界能源统计年鉴》数据显示原油产量下降。');
  assert.ok(!/[（(]|来源|^但/.test(lead), lead);
  assert.ok(lead.startsWith('结构性趋势难以在短期内逆转'), lead);
}

// 4. End to end on the PDF's own material: no splices, no blanks inside Chinese, no repeated passage, no junk glossary.
{
  const pass = (n: number, title: string, url: string, content: string) => ({
    id: `q-${n}`, title, url, content,
    definitions: extractDefinitionsFromSentences(content.split(/(?<=[。！？])/), url),
    subTopics: [], informativeScore: 0.9, authorityScore: 0.9, fitness: 0,
  });
  const oil = '马来西亚的石油储存并不是一个单一的巨大油库，而是一个由国家石油公司主导的、复杂的物理网络。根据美国能源信息署发布的数据，马来西亚已探明石油储量约为27亿桶，位居东南亚第二。2024年，马来西亚上游投资额达到500亿令吉，为国家石油公司成立以来最高。';
  const tail = '燃油补贴制度可以追溯至1983年，距今已逾四十年。问题不只是总量庞大，更在于分配极度不均。约40%的汽油补贴流向了收入最高的15%人群以及外国人。长期以来，历届政府都清楚补贴制度不可持续。';
  const book = synthesizeFallbackWebBook('马来西亚国油资源分配', [
    // the same passage, once with bold-markup blanks and a snippet splice (as in the generated book), once clean
    pass(1, '焦点 | 能源安全与财政可持续性的平衡', 'https://wepost.example.org/oil',
      `如何平衡国家能源安全与财政可持续性？ ${oil.replace('马来西亚的石油储存并不是', '马来西亚的石油储存并不 是').replace('国家石油公司主导', '国家石油公司 主导')} 在 全球能源市场动荡不休 、 国际油价如 过山车 般起伏的当下，作为 东南亚重要石油生产国 的 马来西亚，正处于一个关键的历史十字路口。 ... 基本 ... 在全球 ${tail}`),
    pass(2, 'PDF 国油资源分配的政治经济学', 'https://niis.example.org/pdf', `${oil} ${tail}`),
  ] as any);

  const all = book.chapters.map((c) => c.content).join('\n\n');
  assert.ok(!/\.{3}|…/.test(all), 'no snippet splice survives');
  assert.ok(!/[\u3400-\u9fff] +[\u3400-\u9fff]/.test(all), 'no blanks between Chinese characters');
  const sentences = all.split(/(?<=[。！？])/).map((x) => x.trim()).filter(Boolean);
  assert.equal(new Set(sentences).size, sentences.length, 'a passage is not repeated because of blanks in one copy');
  assert.ok(!book.chapters.some((c) => /^PDF|^焦点$/.test(c.title)), book.chapters.map((c) => c.title).join(' / '));
  for (const chapter of book.chapters) {
    for (const d of chapter.definitions) assert.ok(isPlausibleChineseTerm(d.term), `junk term: ${d.term}`);
  }
}

// 5. The abstract of a non-English book is in its language, not the engine's English diagnostic.
{
  const note = 'Selected Gemini model: gemini-3.6-flash unavailable (API key rejected); gathered evidence via DuckDuckGo fallback (Google contributed no results). Compiled offline from 4 sources (65 sentences, 2997 words).';
  const zh = { topic: '马来西亚团结政府政权维持机制', chapters: [], generationNote: note, sourceMode: 'fallback_search', timestamp: 0 } as unknown as WebBook;
  const abstract = getExecutiveOverview(zh);
  assert.ok(!/Gemini|Selected|DuckDuckGo/.test(abstract), abstract);
  assert.ok(/4/.test(abstract) && /65/.test(abstract) && /2997/.test(abstract) && abstract.includes('马来西亚团结政府政权维持机制'), abstract);

  const noStats = getExecutiveOverview({ ...zh, generationNote: 'Selected Gemini model: x unavailable.' } as WebBook);
  assert.ok(!/Gemini/.test(noStats) && noStats.includes('马来西亚团结政府政权维持机制'), noStats);

  const en = { ...zh, topic: 'Malaysia unity government', chapters: [{ title: 'Energy subsidies', content: 'Fuel subsidies are costly.', definitions: [], subTopics: [], sourceUrls: [], visualSeed: 'x' }] } as unknown as WebBook;
  assert.equal(getExecutiveOverview(en), note, 'an English book keeps the note');

  for (const locale of ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'ms', 'es', 'fr', 'de'] as const) {
    const text = getExportLabelsForLocale(locale).offlineOverview('T', 4, 65, 2997);
    assert.ok(text.includes('T') && text.includes('4') && text.includes('65') && text.includes('2997'), `${locale}: ${text}`);
  }
}

console.log('offlineQuality tests passed');
