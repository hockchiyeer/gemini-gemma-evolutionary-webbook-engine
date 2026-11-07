import assert from 'node:assert/strict';
import { DEFAULT_DOCUMENT_TITLE, clipLabelAtWordBoundary, getWebBookDocumentTitle, summarizeTitle } from '../../src/services/documentTitle.ts';

assert.equal(
  getWebBookDocumentTitle('Climate Change'),
  'Climate Change',
  'A real Web-book topic should become the browser document title.'
);

assert.equal(
  getWebBookDocumentTitle('  Sustainable Cities  '),
  'Sustainable Cities',
  'Whitespace around the topic should be trimmed before being used as a title.'
);

assert.equal(
  getWebBookDocumentTitle(''),
  DEFAULT_DOCUMENT_TITLE,
  'Blank topics should fall back to the app title.'
);

assert.equal(
  getWebBookDocumentTitle(undefined),
  DEFAULT_DOCUMENT_TITLE,
  'Missing topics should fall back to the app title.'
);

// Cover-title summarization: over-long query-derived titles must read as complete, never as a mid-word cut.
const longQuery =
  "AI's biggest drivers and sources of revenue are cloud infrastructure, cloud services, energy, real estate, " +
  'semiconductors, AI chips, and hardware peripherals, networking and cooling systems';
const summary = summarizeTitle(longQuery);
assert.ok(summary.length < longQuery.length && summary.endsWith('…'), 'Long titles are shortened and marked with an ellipsis.');
assert.ok(summary.length <= 90, 'Summary fits the cover budget.');
assert.ok(longQuery.startsWith(summary.slice(0, -1)), 'Summary is a clean prefix of the original title.');
assert.ok(!/[,;:\s]…$/.test(summary) && !/\b(and|or|of|the|are)…$/i.test(summary), 'Summary never ends on a dangling comma or connector.');
assert.equal(summarizeTitle('Climate Change'), 'Climate Change', 'Short titles are untouched.');
assert.equal(summarizeTitle('  Spaced   out \n title '), 'Spaced out title', 'Whitespace is normalized.');
assert.equal(summarizeTitle(''), '', 'Blank titles stay blank.');
assert.equal(summarizeTitle(undefined), '', 'Missing titles stay blank.');
const noSpaces = summarizeTitle('x'.repeat(300));
assert.ok(noSpaces.length <= 90 && noSpaces.endsWith('…'), 'Unbroken strings are still bounded.');
const cjk = summarizeTitle('马来西亚政治格局与未来发展趋势深度分析报告'.repeat(4));
assert.ok(cjk.length <= 45 && cjk.endsWith('…'), 'CJK titles use a double-width budget.');

// The 160-character label cap must not leave a half word behind (the original "peripherals, n" bug).
const midWord = `${'word '.repeat(31)}peripherals, networking`;
const clipped = clipLabelAtWordBoundary(midWord, 160);
assert.ok(clipped.length <= 160 && clipped.endsWith('…') && !clipped.includes('networking'), 'Label cap never keeps a partial word.');
assert.equal(clipLabelAtWordBoundary('short label', 160), 'short label');

// Edge Case 1: Unpunctuated English title (must cut on word boundary and strip dangling connectors)
const unpunctuatedEnglish = 'The rapid advancement of artificial intelligence and deep neural networks in modern healthcare diagnostics';
const unpunctuatedSummary = summarizeTitle(unpunctuatedEnglish);
assert.ok(unpunctuatedSummary.length <= 90 && unpunctuatedSummary.endsWith('…'), 'Unpunctuated English title fits in 90 units.');
assert.ok(!/\b(in|and|of|the|to|a|an)\s*…$/i.test(unpunctuatedSummary), 'No dangling connector before ellipsis in unpunctuated title.');
assert.ok(unpunctuatedEnglish.startsWith(unpunctuatedSummary.slice(0, -1)), 'Summary is a clean prefix.');
assert.ok(!unpunctuatedSummary.includes('health…'), 'Word is not cut mid-word.');

// Edge Case 2: Boundary conditions around 90-unit threshold
const exactly90Latin = 'A'.repeat(90);
assert.equal(summarizeTitle(exactly90Latin), exactly90Latin, 'Title with exactly 90 Latin characters is untouched.');

const justOverLatin = `${'Word '.repeat(17)}Final and extra`; // 90+ chars
const justOverSummary = summarizeTitle(justOverLatin);
assert.ok(justOverSummary.length <= 90 && justOverSummary.endsWith('…'), 'Title just over 90 units is shortened.');
assert.ok(!/\b(and|or|of)\s*…$/i.test(justOverSummary), 'Dangling "and" stripped at boundary.');

const exactly45CJK = '中'.repeat(45); // 45 * 2 = 90 units
assert.equal(summarizeTitle(exactly45CJK), exactly45CJK, 'Title with exactly 45 CJK characters (90 units) is untouched.');

const justOver46CJK = '中'.repeat(46); // 46 * 2 = 92 units
assert.equal(summarizeTitle(justOver46CJK), `${'中'.repeat(44)}…`, 'Title with 46 CJK characters is shortened to 44 chars + ellipsis (89 units).');

// Edge Case 3: Very long CJK query with and without punctuation
const cjkNoPunct = '量子计算与人工智能深度学习算法在生物医药分子结构预测与药物研发中的前沿应用实践研究以及未来产业趋势探讨';
const cjkNoPunctSummary = summarizeTitle(cjkNoPunct);
assert.ok(cjkNoPunctSummary.length === 45 && cjkNoPunctSummary.endsWith('…'), 'Long CJK without punctuation is cleanly bounded to 44 CJK chars + ellipsis.');
assert.ok(cjkNoPunct.startsWith(cjkNoPunctSummary.slice(0, -1)), 'CJK summary is a clean prefix.');

const cjkWithPunct = '中国古代科技史：从四大发明到农业手工业与天文历法的演变进程及其对世界文明的深远影响与启示录完结篇';
const cjkWithPunctSummary = summarizeTitle(cjkWithPunct);
assert.ok(cjkWithPunctSummary.length <= 45 && cjkWithPunctSummary.endsWith('…'), 'Long CJK with punctuation fits cover budget.');
assert.ok(!/[，：；、。]\s*…$/.test(cjkWithPunctSummary), 'No dangling punctuation before ellipsis in CJK title.');

console.log('documentTitle regression checks passed');


