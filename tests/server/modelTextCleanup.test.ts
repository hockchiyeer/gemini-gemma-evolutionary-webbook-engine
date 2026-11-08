import assert from 'node:assert/strict';
import { BOOK_CHAPTER_COUNT, balanceBrackets, cleanChapterContent, cleanTermLabel, stripMarkdownInline } from '../../src/services/modelTextCleanup.ts';

assert.equal(BOOK_CHAPTER_COUNT, 10);

// dropped closing brackets
assert.equal(cleanTermLabel('改革困局 (Reform Dilemma'), '改革困局 (Reform Dilemma)');
assert.equal(cleanTermLabel('合法性 (Legitimacy:'), '合法性 (Legitimacy)');
assert.equal(balanceBrackets('术语（English'), '术语（English）');
assert.equal(balanceBrackets('Public Image (PI)'), 'Public Image (PI)');
assert.equal(cleanTermLabel('**网红律师 (Influencer Lawyer)**'), '网红律师 (Influencer Lawyer)');

// markdown
assert.equal(stripMarkdownInline('**核心：** 内容'), '核心： 内容');
const body = [
  '## 第六章：高潮迭起：11月29日的终极对决',
  '',
  '本章聚焦于对决。',
  '',
  '**人物定义与分析**',
  '',
  '**网红律师 (Influencer Lawyer):** 指利用社交媒体的律师。',
  '',
  '### 小节标题',
  '正文。',
].join('\n');
const cleaned = cleanChapterContent(body, '擂台初战：11月8日的试探性对决');
assert.ok(!/[#*]/.test(cleaned), cleaned);
assert.ok(!cleaned.includes('第六章'));
assert.ok(cleaned.includes('网红律师 (Influencer Lawyer): 指利用社交媒体的律师。'));
assert.ok(cleaned.includes('小节标题\n正文。'));
// a heading equal to the title is dropped even without a number
assert.equal(cleanChapterContent('# 序章：背景\n\n正文', '第1章：序章：背景'), '正文');
assert.equal(cleanChapterContent('', 'x'), '');
console.log('modelTextCleanup tests passed');

// chapter title repeated as the first line of the body
import { isTitleEcho } from '../../src/services/modelTextCleanup.ts';
assert.equal(cleanChapterContent('马来—穆斯林政治整合的动力与战略考量\n\n在马来西亚政治格局的宏观转向背景下，整合已成为核心动力。', '马来—穆斯林政治整合的动力与战略考量').startsWith('在马来西亚'), true);
assert.equal(cleanChapterContent('马来西亚政治未来路径选择：渐进式保守化与剧变风险评估\n\n正文第一句。', '未来政治的路径选择：渐进式保守化与剧变风险评估'), '正文第一句。');
assert.equal(isTitleEcho('本章旨在深入探讨公民社会组织与在野党之间签署跨党派协议的机制。', '政治参与的深化：跨党派协议与公民社会的监督力量'), false);
assert.equal(cleanChapterContent('本章旨在探讨政治参与。\n\n第二段。', '政治参与的深化'), '本章旨在探讨政治参与。\n\n第二段。');
console.log('title echo tests passed');
