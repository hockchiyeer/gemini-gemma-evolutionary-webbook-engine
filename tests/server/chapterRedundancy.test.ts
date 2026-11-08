import assert from 'node:assert/strict';
import { dedupeByLabel, localizeVisualSeed, removeRepeatedSections } from '../../src/utils/chapterRedundancy.ts';
import { sanitizeWebBookForPresentation } from '../../src/utils/webBookRender.ts';
import type { WebBook } from '../../src/types.ts';

const defs = [
  { term: '网红律师 (Influencer Lawyer)', description: '指那些利用社交媒体平台，通过专业法律知识和个人魅力，建立起广泛公众关注度和信任基础的法律从业者。' },
  { term: '公众形象', description: '指个体在社会群体中被他人认知和评价的整体形象，包括其职业身份、价值观和行为模式。' },
];
const subs = [{ title: '洪伟翔的法律与公众形象构建', summary: '洪伟翔的公众形象构建是一个高度策略化的过程。他通过在社交媒体上积极参与社会热点话题，成功地将自身定位为意见领袖。' }];
const body = [
  '本章旨在为后续对决奠定基础，梳理两位人物的背景。',
  '人物定义与分析',
  '网红律师 (Influencer Lawyer): 指那些利用社交媒体平台，通过专业法律知识和个人魅力，建立起广泛公众关注度和信任基础的法律从业者。',
  '公众形象: 指个体在社会群体中被他人认知和评价的整体形象，包括其职业身份、价值观和行为模式。',
  '洪伟翔的法律与公众形象构建',
  '洪伟翔的公众形象构建是一个高度策略化的过程。他通过在社交媒体上积极参与社会热点话题，成功地将自身定位为意见领袖。',
  '两人的互动呈现出专业权威与政治参与者之间的张力，这是本章独有的分析内容，没有出现在别处。',
].join('\n\n');
const out = removeRepeatedSections(body, defs, subs);
assert.ok(out.includes('本章旨在'));
assert.ok(out.includes('独有的分析'));
assert.ok(!out.includes('网红律师 (Influencer Lawyer): 指'), out);
assert.ok(!out.includes('人物定义与分析'));
assert.ok(!out.includes('洪伟翔的公众形象构建是'));
assert.equal(removeRepeatedSections('只有一段正文。', defs, subs), '只有一段正文。');
assert.equal(removeRepeatedSections(body, [], []), body.trim());

assert.deepEqual(dedupeByLabel([{ t: '运动精神' }, { t: '运动精神 (Sports Spirit)' }, { t: '其他' }], (x) => x.t).map((x) => x.t), ['运动精神', '其他']);

// visual caption language
const zh = { title: '擂台初战：对决的开场', sample: '本章聚焦于洪伟翔与丘光耀的擂台对决，这是一场备受关注的赛事。' };
assert.equal(localizeVisualSeed('An image depicting a boxing ring', zh), '擂台初战：对决的开场');
assert.equal(localizeVisualSeed('拳击擂台的紧张开场', zh), '拳击擂台的紧张开场');
assert.equal(localizeVisualSeed('An image depicting a boxing ring', { title: 'Boxing', sample: 'The match took place in a ring in front of an audience of three hundred people.' }), 'An image depicting a boxing ring');

// end to end through the shared presentation sanitiser (used by text, PDF, DOCX, HTML and the viewer)
const book = {
  topic: '洪伟翔与丘光耀的擂台约战',
  chapters: [{ title: '序章：时代背景', content: `## 第一章：序章\n\n${body.replace(/^/, '')}`, definitions: defs, subTopics: subs, sourceUrls: [], visualSeed: 'An image depicting a political storm cloud over Kuala Lumpur' }],
} as unknown as WebBook;
const presented = sanitizeWebBookForPresentation(book).chapters[0];
assert.ok(/[一-鿿]/.test(presented.visualSeed), presented.visualSeed);
assert.ok(!presented.content.includes('第一章'));
assert.ok(!presented.content.includes('指那些利用社交媒体平台'));
assert.ok(presented.content.includes('独有的分析'));
assert.equal(presented.definitions.length, 2);
console.log('chapterRedundancy tests passed');

// a body that would be left with a single paragraph keeps its first copy
{
  const d = [{ term: '公民社会组织', description: '公民社会组织是指在国家框架之外，由公民自发组织起来的非营利性团体，致力于推动社会议题和政策改革。' }];
  const b = '本章探讨公民监督。\n\n公民社会组织是指在国家框架之外，由公民自发组织起来的非营利性团体，致力于推动社会议题和政策改革。';
  assert.equal(removeRepeatedSections(b, d, []), b);
  const three = `${b}\n\n本章还有独有的分析内容，与任何定义都不同，讨论监督机制的运作方式。`;
  assert.ok(!removeRepeatedSections(three, d, []).includes('非营利性团体'));
}
console.log('redundancy safety-net test passed');
