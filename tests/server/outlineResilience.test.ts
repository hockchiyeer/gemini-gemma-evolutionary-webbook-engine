import assert from 'node:assert/strict';
import {
  COMPACT_OUTLINE_CHAPTER_COUNT,
  assembleWebBook,
  buildEvidenceOutline,
  isClippedStub,
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

// --- 1. isClippedStub drops truncated fragments and stubs -------------------------------------------------------------
{
  assert.equal(isClippedStub('S'), true, 'lone single letter is a stub');
  assert.equal(isClippedStub('S.'), true, 'single letter with punctuation is a stub');
  assert.equal(isClippedStub('  '), true, 'whitespace is empty/stub');
  assert.equal(isClippedStub('th'), true, 'two letters is a stub');
  assert.equal(isClippedStub('的'), true, 'single CJK char is a stub');
  assert.equal(isClippedStub('新谣是新加坡本土的音乐创作。'), false, 'full Chinese sentence is kept');
  assert.equal(isClippedStub('Xinyao emerged in the 1980s as a distinct genre.'), false, 'full English sentence is kept');
}

// --- 2. Offline Chinese books filter mostly-Latin sentences unless evidence would be too thin ------------------------
{
  const makePage = (id: string, url: string, title: string, content: string): WebPageGenotype => ({
    id,
    url,
    title,
    content,
    definitions: [],
    subTopics: [],
    informativeScore: 0.9,
    authorityScore: 0.9,
    fitness: 0,
  });

  const chineseSentences = [
    '新谣是新加坡本土的华语原创歌曲。',
    '新谣在二十世纪八十年代的新加坡学生群体中兴起。',
    '梁文福是新谣发展史上的核心人物之一。',
    '新谣歌曲反映了年轻一代对生活与社会的真挚感受。',
    '许多经典新谣曲目在东南亚华语圈广泛传唱。',
    '新谣代表作包括细水长流和一步一步来等。',
  ];

  const englishSentences = [
    'Xinyao is a genre of contemporary Mandarin vocal music unique to Singapore.',
    'It began in the late 1970s among local high school and university students.',
    'The movement experienced rapid decline in the 1990s as commercial Mandopop dominated.',
    'Prominent composers include Liang Wern Fook and Billy Koh.',
  ];

  // Case A: Chinese book with sufficient Chinese sentences filters out English paragraphs
  const pagesWithMixed = [
    makePage('p1', 'https://zh.wikipedia.org/wiki/xinyao', '新谣 - 维基百科', chineseSentences.join(' ')),
    makePage('p2', 'https://en.wikipedia.org/wiki/xinyao', 'Xinyao - Wikipedia', englishSentences.join(' ') + ' S'),
  ];

  const bookA = synthesizeFallbackWebBook('新加坡歌谣', pagesWithMixed);
  assert.ok(bookA.chapters.length >= 1, 'book must have chapters');
  assert.match(bookA.generationNote || '', /non-Chinese sentence.*left out/, 'generation note mentions non-Chinese sentences left out');
  assert.ok(!bookA.chapters.some((ch) => ch.content.includes('contemporary Mandarin vocal music')), 'English Wikipedia sentences dropped');
  assert.ok(!bookA.chapters.some((ch) => ch.content.includes(' decline in xinyao. S ')), 'clipped stub S is dropped');

  // Case B: Chinese book with fewer than 4 Chinese sentences keeps English sentences so book is not empty
  const pagesFewChinese = [
    makePage('p1', 'https://zh.wikipedia.org/wiki/xinyao', '新谣 - 维基百科', chineseSentences.slice(0, 2).join(' ')),
    makePage('p2', 'https://en.wikipedia.org/wiki/xinyao', 'Xinyao - Wikipedia', englishSentences.join(' ')),
  ];
  const bookB = synthesizeFallbackWebBook('新加坡歌谣', pagesFewChinese);
  assert.ok(bookB.chapters.length >= 1, 'book must have chapters');
  assert.ok(!bookB.generationNote?.includes('non-Chinese sentences were left out'), 'English sentences kept when Chinese evidence < 4');

  // Case C: English book is completely unaffected by Latin filtering
  const bookC = synthesizeFallbackWebBook('Singapore Folk Songs', pagesWithMixed);
  assert.ok(!bookC.generationNote?.includes('non-Chinese sentences were left out'), 'English book not subject to Latin filtering');
}

// --- 3. buildEvidenceOutline creates structured outlines from source titles -----------------------------------------
{
  const testPages: WebPageGenotype[] = [
    {
      id: 'p1',
      url: 'https://sccc.org.sg/singapore-chinese-music',
      title: '新加坡华族音乐发展史 - 新加坡华族文化中心',
      content: '新加坡华族音乐源远流长。多元文化在此交汇融合。',
      definitions: [{ term: '华族音乐', description: '新加坡华人的传统与现代音乐总称。' }],
      subTopics: [{ title: '发展阶段', summary: '从早期萌芽到现代多元创新。' }],
      informativeScore: 0.9,
      authorityScore: 0.9,
      fitness: 0,
    },
    {
      id: 'p2',
      url: 'https://zh.wikipedia.org/wiki/xinyao',
      title: '新谣 - 维基百科，自由的百科全书',
      content: '新谣是新加坡学生的原创音乐运动。',
      definitions: [{ term: '新谣', description: '新加坡年轻人自创自唱的民谣。' }],
      subTopics: [{ title: '校园民谣', summary: '学生创作与校园演唱风潮。' }],
      informativeScore: 0.9,
      authorityScore: 0.9,
      fitness: 0,
    },
    {
      id: 'p3',
      url: 'https://8world.com/entertainment/liang-wern-fook',
      title: '梁文福的新谣艺术与文学追求 - 8视界',
      content: '梁文福词作文学底蕴深厚。他的歌曲记录了时代变迁。',
      definitions: [{ term: '文学词作', description: '结合南洋地域色彩的诗性词作。' }],
      subTopics: [{ title: '音乐风格', summary: '民谣吉他与抒情旋律结合。' }],
      informativeScore: 0.9,
      authorityScore: 0.9,
      fitness: 0,
    },
  ];

  const evidenceOutline = buildEvidenceOutline('新加坡歌谣', testPages);
  assert.ok(evidenceOutline.length >= 3, 'buildEvidenceOutline builds chapters from pages');
  assert.ok(evidenceOutline.length <= COMPACT_OUTLINE_CHAPTER_COUNT, 'does not exceed compact cap');
  assert.ok(evidenceOutline.every((entry) => entry.title && entry.focus && entry.terms.length > 0 && entry.subTopicTitles.length > 0));
  assert.ok(!evidenceOutline.some((entry) => entry.title.includes('维基百科')), 'site names stripped from titles');
  assert.ok(!evidenceOutline.some((entry) => entry.title.includes('Wikipedia')), 'site names stripped from titles');
}

// --- 4. Outline failure resilience: compact retry and evidence fallback ----------------------------------------------
{
  let requests: any[] = [];
  globals.fetch = async (input: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    requests.push(body);
    const contentStr = String(body.contents || '');
    const isOutline = Boolean(body.config?.responseSchema?.properties?.outline);
    const isCompactOutline = isOutline && body.config?.maxOutputTokens === 4096;

    if (isOutline) {
      if (testMode === 'primary_fails_compact_succeeds') {
        if (!isCompactOutline) {
          // 10-chapter outline fails with a timeout / 504
          return json({ error: { code: 504, status: 'TIMEOUT', message: 'outline timed out' } }, 504);
        }
        // 6-chapter outline succeeds
        const compactOutline = Array.from({ length: 6 }, (_, i) => ({
          title: `Compact Chapter ${i + 1}`,
          focus: 'Focus for compact chapter.',
          terms: ['term1', 'term2', 'term3', 'term4'],
          subTopicTitles: ['sub1', 'sub2', 'sub3'],
          visualSeed: `seed ${i + 1}`,
        }));
        return json({ text: JSON.stringify({ topic: '新加坡歌谣', outline: compactOutline }) });
      }

      if (testMode === 'both_outlines_fail_evidence_used') {
        // Both 10-chapter and 6-chapter outlines fail
        return json({ error: { code: 504, status: 'TIMEOUT', message: 'outline timed out' } }, 504);
      }

      if (testMode === 'unrecoverable_outline_fails_stops') {
        // Daily quota exhausted
        return json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', reason: 'quota_daily', message: 'daily quota' } }, 429);
      }
    }

    // Chapter requests succeed
    return json({
      text: JSON.stringify({
        content: 'Detailed chapter narrative discussing Singapore music culture. '.repeat(20),
        definitions: [{ term: '新谣', description: '新加坡本土音乐。' }],
        subTopics: [{ title: '校园时期', summary: '学生时代的新谣风潮。' }],
      }),
    });
  };

  const testPages: WebPageGenotype[] = Array.from({ length: 6 }, (_, i) => ({
    id: `p${i}`,
    url: `https://example.org/p${i}`,
    title: `新谣历史阶段与文化影响 第${i + 1}章`,
    content: `新谣文化深入人心，展示了新加坡华语音乐的独特面貌。`.repeat(10),
    definitions: [{ term: `术语${i}`, description: '定义内容' }],
    subTopics: [{ title: `子主题${i}`, summary: '分析内容' }],
    informativeScore: 0.9,
    authorityScore: 0.9,
    fitness: 0,
  }));
  const searchResult = { sourceMode: 'gemini' as const, generationNote: 'Research complete.' };

  // Scenario 1: Primary outline fails, compact 6-chapter outline retry succeeds
  let testMode = 'primary_fails_compact_succeeds';
  requests = [];
  const book1 = await assembleWebBook(testPages, '新加坡歌谣', searchResult, {
    mode: 'google_duckduckgo',
    geminiModel: 'gemini-3.8-flash',
  });
  assert.equal(book1.chapters.length, 6, '6 chapters produced via compact outline retry');
  assert.equal(book1.sourceMode, 'gemini');
  assert.match(book1.generationNote || '', /Outline generated via 6-chapter retry/, 'generation note mentions 6-chapter retry');

  // Scenario 2: Both primary and compact outline requests fail, evidence outline is used, model writes chapters
  testMode = 'both_outlines_fail_evidence_used';
  requests = [];
  const book2 = await assembleWebBook(testPages, '新加坡歌谣', searchResult, {
    mode: 'google_duckduckgo',
    geminiModel: 'gemini-3.8-flash',
  });
  assert.ok(book2.chapters.length >= 3, 'chapters written by model using evidence outline');
  assert.equal(book2.sourceMode, 'gemini');
  assert.match(book2.generationNote || '', /Outline derived from gathered sources/, 'generation note mentions evidence outline');

  // Scenario 3: Unrecoverable outline failure in Gemini-only mode throws
  testMode = 'unrecoverable_outline_fails_stops';
  requests = [];
  await assert.rejects(
    assembleWebBook(testPages, '新加坡歌谣', searchResult, {
      mode: 'off',
      geminiModel: 'gemini-3.8-flash',
    }),
    /daily quota/i,
    'unrecoverable failure throws in Gemini-only mode'
  );
}

console.log('outlineResilience tests passed');
