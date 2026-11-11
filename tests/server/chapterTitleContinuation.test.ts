import assert from 'node:assert/strict';
import { cleanSourceTitle, continuationTitle, synthesizeFallbackWebBook } from '../../src/services/evolutionService.ts';
import type { WebPageGenotype } from '../../src/types.ts';

// --- 1. A site name stuck to the headline is not part of the heading ----------------------------------------------------
assert.equal(cleanSourceTitle('【一文看懂】纳吉之前争取居家服刑碰壁 为何这次获准？8world', 'https://www.8world.com/southeast-asia/x'), '【一文看懂】纳吉之前争取居家服刑碰壁 为何这次获准？');
assert.equal(cleanSourceTitle('马来西亚前总理纳吉布，缴清5000万林吉特罚款，获准以居家监禁方式服完剩余刑期_凤凰网', 'https://news.ifeng.com/c/8x'), '马来西亚前总理纳吉布，缴清5000万林吉特罚款，获准以居家监禁方式服完剩余刑期');
assert.equal(cleanSourceTitle('Latest news', 'https://news.example.com/'), 'Latest news', 'a Latin title that ends in the host word is left alone');
assert.equal(cleanSourceTitle('my_file_name', 'https://x.example.com/'), 'my_file_name');

// --- 2. Continuation headings ---------------------------------------------------------------------------------------------
assert.equal(continuationTitle('新谣的传播与新加坡文化记忆', 2), '新谣的传播与新加坡文化记忆（续）');
assert.equal(continuationTitle('新谣的传播与新加坡文化记忆', 3), '新谣的传播与新加坡文化记忆（续2）');
assert.equal(continuationTitle('新旧交替间的歌曲创作（1980年代至2000年代）', 2), '新旧交替间的歌曲创作（1980年代至2000年代） · 续');
assert.equal(continuationTitle('新謠的傳播', 2), '新謠的傳播（續）');
assert.equal(continuationTitle('Xinyao', 2), 'Xinyao (continued)');

// --- 3. A source that spans several chapters is titled by itself, not by clauses cut from its body -------------------------
{
  // Distinct sentences (each built from its own characters) so the evidence de-duplication keeps all of them.
  const word = (seed: number) => Array.from({ length: 6 }, (_, k) => String.fromCharCode(0x4e00 + ((seed * 37 + k * 211) % 5000))).join('');
  const sentences = (tag: string, n: number) => Array.from({ length: n }, (_, i) => `在${tag}领域，${word(i + tag.length * 100)}与${word(i + 7)}促成了${word(i + 13)}，并留下了${word(i + 29)}的记录。`).join('');
  const page = (id: string, url: string, title: string, content: string): WebPageGenotype => ({ id, url, title, content, definitions: [], subTopics: [], informativeScore: 0.8, authorityScore: 0.8, fitness: 0 });
  const book = synthesizeFallbackWebBook('新加坡歌谣', [
    page('a', 'https://sfcca.sg/a', '新谣的传播与新加坡文化记忆 - Singapore Federation of Chinese Clan Associations', sentences('广播', 60)),
    page('b', 'https://culture.example.org/b', '新旧交替间的新加坡华语歌曲创作 - 华族文化中心', sentences('合唱', 20)),
  ]);
  const titles = book.chapters.map((c) => c.title);
  assert.ok(titles.length >= 3, `the long source spans several chapters (got ${titles.length})`);
  assert.equal(new Set(titles).size, titles.length, 'titles are unique');
  assert.ok(titles.every((t) => /^新谣的传播与新加坡文化记忆|^新旧交替间的新加坡华语歌曲创作/.test(t)), `every heading names a source, not a body clause: ${JSON.stringify(titles)}`);
  assert.ok(titles.some((t) => /（续\d?）$/.test(t)), 'a chapter that carries on a source says so');
}

console.log('chapterTitleContinuation tests passed');
