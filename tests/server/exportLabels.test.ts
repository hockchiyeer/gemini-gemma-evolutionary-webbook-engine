import assert from 'node:assert/strict';
import { detectBookLocale, detectTextLocale, getExportLabels, getExportLabelsForLocale } from '../../src/services/exportLabels.ts';

console.log('Running export label localisation tests...');

const book = (topic: string, title: string, content: string): any => ({ topic, chapters: [{ title, content }] });

// Language detection
assert.equal(detectBookLocale(book('打着清廉旗号的团结政府', '破局的承诺', '第15届全国大选后，经历了峰回路转的5天才迎来团结政府，安华在历经20多年漫长且曲折的反对党生涯后')), 'zh-Hans');
assert.equal(detectTextLocale('這個政府的體制與經濟發展，讓我們對於時間的認識與實質進展有所不同。經濟學家說'), 'zh-Hant');
assert.equal(detectTextLocale('日本の経済政策は、これまでの歴史の中でさまざまな変化を遂げてきました。ひらがなとカタカナ'), 'ja');
assert.equal(detectTextLocale('한국의 경제 정책은 지난 수십 년 동안 많은 변화를 겪었습니다. 이 책은 그 역사를 다룹니다'), 'ko');
assert.equal(detectBookLocale(book('Quantum computing', 'Foundations', 'Quantum computing is the study of the behavior of matter and energy at the smallest scales, and it is one of the most important fields. '.repeat(4))), 'en');
assert.equal(detectBookLocale(null), 'en');
assert.equal(detectBookLocale({ topic: '', chapters: [] } as any), 'en');
// A Chinese topic with an English visual seed / source names must still be Chinese.
assert.equal(detectBookLocale(book('马来西亚 Madani 治理', 'Madani治理危局', '反腐败叙事逐渐变质为巩固政治权力的工具，财政紧缩与价格统制化作压在中小企业和底层民众身上的重担。')), 'zh-Hans');

// English output is unchanged from the original hard-coded strings.
const en = getExportLabelsForLocale('en');
assert.equal(en.upper(en.chapter(3)), 'CHAPTER 3');
assert.equal(en.upper(en.chapterOf(1, 10)), 'CHAPTER 1 OF 10');
assert.equal(en.upper(en.overviewNarrative), 'OVERVIEW & NARRATIVE');
assert.equal(en.upper(en.visualConcept), 'VISUAL CONCEPT');
assert.equal(en.upper(en.coreConcepts), 'CORE CONCEPTS');
assert.equal(en.upper(en.keyDomainConcepts), 'KEY DOMAIN CONCEPTS');
assert.equal(en.upper(en.subTopics), 'SUB-TOPICS');
assert.equal(en.upper(en.deeperAngles), 'DEEPER ANGLES & EXPLORATION');
assert.equal(en.upper(en.sources), 'SOURCES');
assert.equal(en.upper(en.verifiedSources), 'VERIFIED SOURCE CITATIONS');
assert.equal(en.sourceArticle, 'Source Article');
assert.equal(en.upper(en.pageOf(3, 22)), 'PAGE 3 OF 22');
assert.equal(en.upper(en.pageShort(1)), 'PAGE 1');
assert.equal(en.chapterSlash(2, 10), 'Chapter 2 / 10');
assert.equal(en.pageRef(5), 'P. 5');
assert.equal(en.upper(en.engineName), 'EVOLUTIONARY WEB-BOOK ENGINE');
assert.equal(en.passComplete, 'Engine v2.5 - Evolutionary Pass Complete');
assert.equal(en.colon, ': ');
assert.equal(en.dateLocale, undefined);

// Chinese labels contain no leftover English words and cover every fixed string.
const zh = getExportLabels(book('马来西亚政治', '政治格局', '马来西亚政治格局和国家政治走向的深入分析，涵盖政府治理改革与公共服务提升。'.repeat(3)));
assert.equal(zh.locale, 'zh-Hans');
assert.equal(zh.chapter(1), '第1章');
assert.equal(zh.visualConcept, '视觉概念');
assert.equal(zh.coreConcepts, '核心概念');
assert.equal(zh.subTopics, '小标题');
assert.equal(zh.sources, '参考资料出处');
assert.equal(zh.colon, '：');
const stringKeys = Object.entries(zh).filter(([, value]) => typeof value === 'string') as Array<[string, string]>;
const allowedLatin = new Set(['locale', 'dateLocale', 'passComplete', 'passCompleteDoc', 'docNote']);
for (const [key, value] of stringKeys) {
  if (allowedLatin.has(key)) continue;
  assert.ok(!/[A-Za-z]{3,}/.test(value), `zh-Hans label "${key}" still contains English: ${value}`);
}

// Every locale defines every label (no undefined/empty values) and the functions work.
for (const locale of ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'ms', 'es', 'fr', 'de'] as const) {
  const labels: any = getExportLabelsForLocale(locale);
  for (const [key, value] of Object.entries(labels)) {
    if (key === 'dateLocale') continue;
    assert.ok(value !== undefined && value !== '', `${locale}.${key} is missing`);
  }
  for (const text of [labels.chapter(1), labels.chapterOf(1, 10), labels.chapterSlash(1, 10), labels.pageOf(1, 2), labels.pageShort(1), labels.pageRef(1), labels.navigateTo(1), labels.conceptCount(2), labels.chapterCount(2), labels.chaptersAndSections(2, 3), labels.overviewFallback('X')]) {
    assert.ok(typeof text === 'string' && text.length > 0, `${locale} formatter returned an empty string`);
  }
}

console.log('Export label localisation tests passed');
