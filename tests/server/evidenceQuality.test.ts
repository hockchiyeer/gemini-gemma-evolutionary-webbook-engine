import assert from 'node:assert/strict';
import { isBibliographicCitation, isEventFragmentDefinition, isSiteChromePage, selectRelevantPages, topicOverlap } from '../../src/utils/evidenceQuality.ts';

assert.equal(isSiteChromePage('https://www.orientaldaily.com.my/about', '公司简介 (orientaldaily.com.my)'), true);
assert.equal(isSiteChromePage('https://www.orientaldaily.com.my/news/ufood-activities', '活动'), true);
assert.equal(isSiteChromePage('https://www.orientaldaily.com.my/news/lunjian/2026/09/24/849916', '振民：大马转向极端保守路线？'), false);
assert.equal(isSiteChromePage('https://example.com/blog/about-climate-policy', 'Climate policy'), false);

assert.equal(isBibliographicCitation('1Rugayah M."Public Enterprises"In Jomo K. Boulder Westview Press 1995 pp.64~65. 2Siddiquee N.A "Public Service Innovations" JOAAG Vol.2 No.1 2007 pp.84.'), true);
assert.equal(isBibliographicCitation('伊党于9月初举行第72届全国代表大会，并通过加强马来—穆斯林政治团结的动议。'), false);
assert.equal(isBibliographicCitation('The report (p. 12) argues that reform has slowed.'), false);

const topic = '马来西亚政治改革刍议';
const pages = [
  { url: 'https://a.my/news/1', title: '大马转向极端保守路线？', content: '马来西亚政治正在进入新的调整阶段，团结政府推动改革，但改革进展缓慢。' },
  { url: 'https://b.my/news/2', title: '安华政府的改革议程', content: '马来西亚政治改革议程面临压力，政治联盟也在重组。' },
  { url: 'https://c.my/about', title: '公司简介', content: '《东方网》新闻以马来西亚国内大小事为要。' },
  { url: 'https://d.my/news/3', title: '活动', content: '喜欢跑步、健身及挑战障碍赛的朋友看过来，吉隆坡6日讯。马来西亚。' },
];
assert.ok(topicOverlap(topic, pages[0].content) > 0.6);
assert.ok(topicOverlap(topic, pages[3].content) < 0.4);
assert.deepEqual(selectRelevantPages(topic, pages).map((p) => p.url), ['https://a.my/news/1', 'https://b.my/news/2']);
// never empties the book
assert.equal(selectRelevantPages(topic, [pages[2], pages[3]]).length, 2);
assert.equal(selectRelevantPages('Climate', pages).length, 2); // short topic: only the two furniture pages are removed
// "definitions" that are the rest of a news sentence
assert.equal(isEventFragmentDefinition('颜登逸', '于9月20日在隆雪华堂配合 百年堂庆 所举办的系列活动之一——"国是论坛"开幕礼致辞时，如是说道。'), true);
assert.equal(isEventFragmentDefinition('首相', '9月20日在国会宣布了新的预算案。'), true);
assert.equal(isEventFragmentDefinition('公民', '在一个国家宪法下被赋予权利与义务、享有法律地位的政治个体。'), false);
assert.equal(isEventFragmentDefinition('政治整合', '指不同政治实体在意识形态和组织上进行融合或合作的过程。'), false);
console.log('evidenceQuality tests passed');
