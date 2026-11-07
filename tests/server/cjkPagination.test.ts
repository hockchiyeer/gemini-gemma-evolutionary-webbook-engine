import assert from 'node:assert/strict';
import { buildChapterRenderPlan } from '../../src/utils/webBookRender.ts';
import type { Chapter } from '../../src/types.ts';

// Test 1: Chinese chapter with multiple sentences must generate distinct pages without duplicating the entire text
const chineseContent = [
  '台北市长选举历来是台湾政坛的重要风向标。',
  '二零二六年十一月的选举备受各界关注，蓝绿白各阵营积极布局。',
  '执政党的选战策略侧重于年轻选民与科技创新政策。',
  '在野阵营则聚焦市政基础设施与交通规划的改善。',
  '市民关心的核心议题包括房价负担、托育托老政策以及都市更新速度。',
  '候选人提出的政见在公开辩论中展开激烈交锋。',
  '民调走势随选战进程不断发生微妙变化。',
  '分析人士指出，中间选民的投票意向将成为决定最终胜负的关键因素。',
].join('');

const chineseChapter: Chapter = {
  title: '2026年台北市长选举选情分析',
  content: chineseContent,
  definitions: [],
  subTopics: [],
  sourceUrls: [],
  visualSeed: '2026年台北市长选举选情分析',
};

const chinesePlan = buildChapterRenderPlan([chineseChapter]);
assert.equal(chinesePlan.length, 1);
const chinesePages = chinesePlan[0].textPages;

// Verify we have 3 narrative pages
assert.equal(chinesePages.length, 3, 'Should produce 3 narrative pages for a standard chapter');

// Verify pages are not empty and not identical duplicates
assert.ok(chinesePages[0].content.length > 0, 'Page 1 should have content');
assert.ok(chinesePages[1].content.length > 0, 'Page 2 should have content');
assert.ok(chinesePages[2].content.length > 0, 'Page 3 should have content');

assert.notEqual(
  chinesePages[0].content,
  chinesePages[1].content,
  'Page 2 must not be an identical duplicate of Page 1'
);
assert.notEqual(
  chinesePages[1].content,
  chinesePages[2].content,
  'Page 3 must not be an identical duplicate of Page 2'
);

// Verify no unwanted spaces were injected between Chinese sentences in any page
for (const page of chinesePages) {
  assert.ok(
    !/。[ ]+[\u4e00-\u9fff]/.test(page.content),
    `Chinese sentence boundary should not have ASCII spaces inserted: ${page.content}`
  );
}

// Test 2: English chapter pagination preserves standard English sentence spacing
const englishContent = [
  'The Taipei mayoral election of November 2026 represents a critical milestone in regional politics. ',
  'Major political parties are evaluating candidates with strong municipal track records and public appeal. ',
  'Voter turnout among younger demographics is anticipated to be an influential determining factor. ',
  'Infrastructure, urban renewal, and housing affordability remain at the forefront of public debate. ',
  'Early polling suggests a competitive contest with fluid voter preferences across key districts. ',
  'Policy platforms emphasize sustainable urban development and technological modernization.',
].join('');

const englishChapter: Chapter = {
  title: 'Analysis of the 2026 Taipei Mayoral Election',
  content: englishContent,
  definitions: [],
  subTopics: [],
  sourceUrls: [],
  visualSeed: 'Analysis of the 2026 Taipei Mayoral Election',
};

const englishPlan = buildChapterRenderPlan([englishChapter]);
const englishPages = englishPlan[0].textPages;
assert.equal(englishPages.length, 3);
import { calculateTextSimilarity } from '../../src/services/searchFallbackShared.ts';

// Test 3: Chinese text similarity regression tests
const identicalPair = calculateTextSimilarity('马来西亚政治格局', '马来西亚政治格局');
assert.ok(identicalPair >= 0.88, `Identical Chinese sentences must score >= 0.88 (got ${identicalPair})`);

const differentYearPair = calculateTextSimilarity('马来西亚政治格局2026', '经济繁荣发展迅速2026');
assert.ok(differentYearPair < 0.5, `Different Chinese sentences sharing 2026 must score < 0.5 (got ${differentYearPair})`);

const differentMadaniPair = calculateTextSimilarity('马来西亚政治格局Madani', '经济繁荣发展迅速Madani');
assert.ok(differentMadaniPair < 0.5, `Different Chinese sentences sharing Madani must score < 0.5 (got ${differentMadaniPair})`);

const oneCharDiffShortPair = calculateTextSimilarity('马来西亚政治格局走向', '马来西亚政治格局发展');
assert.ok(oneCharDiffShortPair > 0.5, `Short close CJK sentences should have similarity > 0.5 (got ${oneCharDiffShortPair})`);

const oneCharDiffLongPair = calculateTextSimilarity('马来西亚政治格局和国家政治走向的深入分析', '马来西亚政治格局和国家政治走向的深入探讨');
assert.ok(oneCharDiffLongPair >= 0.7, `Long close CJK sentences should have high similarity >= 0.7 (got ${oneCharDiffLongPair})`);

console.log('cjkPagination regression tests passed successfully!');
