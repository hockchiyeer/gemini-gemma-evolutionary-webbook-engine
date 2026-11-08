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
