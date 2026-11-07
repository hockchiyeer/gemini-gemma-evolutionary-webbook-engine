import assert from 'node:assert/strict';
import { enrichResultsWithPageExcerpts, extractFollowLinks, PAGE_FOLLOW_MAX_LINKS } from '../../server/searchStrategies/pageExcerpt.ts';
import { classifySourceReliability, countWords, scoreDomainAuthority } from '../../src/services/searchFallbackShared.ts';
import { cleanSourceTitle, synthesizeFallbackWebBook } from '../../src/services/evolutionService.ts';
import type { SearchFallbackResult } from '../../src/types.ts';

// Offline (no Gemini key) books are compiled from web pages. These tests pin how reliable sources are preferred and how
// much substance a chapter must have.

// 1. Reliability tiers.
{
  assert.equal(classifySourceReliability('https://en.wikipedia.org/wiki/X'), 'high');
  assert.equal(classifySourceReliability('https://www.um.edu.my/about'), 'high');
  assert.equal(classifySourceReliability('https://www.moe.gov.my/page'), 'high');
  assert.equal(classifySourceReliability('https://cs.ox.ac.uk/x'), 'high');
  assert.equal(classifySourceReliability('https://pbcum.org/history'), 'medium');
  assert.equal(classifySourceReliability('https://random-blog.example.com/post'), 'medium');
  for (const url of ['https://www.facebook.com/page', 'https://m.facebook.com/page', 'https://www.reddit.com/r/x', 'https://zhihu.com/q/1', 'https://shopee.com.my/item']) {
    assert.equal(classifySourceReliability(url), 'low', url);
  }
  assert.equal(classifySourceReliability('not a url'), 'low');
  assert.ok(scoreDomainAuthority('https://www.facebook.com/x') < scoreDomainAuthority('https://random-blog.example.com/x'));
  assert.ok(scoreDomainAuthority('https://en.wikipedia.org/wiki/X') > scoreDomainAuthority('https://random-blog.example.com/x'));
}

const TOPIC = 'Persatuan Bahasa Cina Universiti Malaya';
const page = (body: string, extra = '') => `<html><head><title>x</title></head><body><main>${body}</main>${extra}</body></html>`;
const para = (text: string) => `<p>${text}</p>`;
const htmlResponse = (html: string) => new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
const result = (url: string, title = 'Result'): SearchFallbackResult => ({ title, url, snippet: `${title} snippet.` });

// 2. The page allowance goes to the most reliable hosts first, and login-walled hosts are never fetched.
{
  const fetched: string[] = [];
  const results = [
    result('https://www.facebook.com/pbcum'),
    result('https://blog-a.example.com/post'),
    result('https://cs.example.edu/society'),
    result('https://blog-b.example.org/post'),
    result('https://en.wikipedia.org/wiki/PBCUM'),
  ];
  const out = await enrichResultsWithPageExcerpts(results, TOPIC, {
    maxPages: 2,
    fetchImpl: async (url) => {
      fetched.push(url);
      return htmlResponse(page(para(`${TOPIC} is a student society that organises cultural festivals and literary talks for its members every year.`)));
    },
  });
  assert.deepEqual(fetched.sort(), ['https://cs.example.edu/society', 'https://en.wikipedia.org/wiki/PBCUM']);
  assert.equal(out.length, 5, 'no result is dropped');
  assert.ok(out.find((r) => r.url.includes('wikipedia'))?.excerpt);
  assert.ok(!out.find((r) => r.url.includes('facebook'))?.excerpt);
}

// 3. Link following: same-site history/about pages only, capped, never off-site, never contact/login pages.
{
  const html = page(
    para('x'.repeat(10)),
    [
      '<a href="/about/history">History of the society</a>',
      '<a href="/sejarah">Sejarah</a>',
      '<a href="https://other-site.example.net/history">History elsewhere</a>',
      '<a href="/contact">Contact us</a>',
      '<a href="/login">Log in</a>',
      '<a href="/about/history#top">History again</a>',
      '<a href="/关于我们">关于我们</a>',
      '<a href="/a/overview">Overview</a>',
      '<a href="/b/profile">Profile</a>',
      '<a href="/gallery.jpg">History photo</a>',
    ].join(''),
  );
  const links = extractFollowLinks(html, 'https://pbcum.org/');
  const urls = links.map((l) => l.url);
  assert.ok(urls.includes('https://pbcum.org/about/history'));
  assert.ok(urls.includes('https://pbcum.org/sejarah'));
  assert.ok(urls.every((u) => u.startsWith('https://pbcum.org/')), 'same host only');
  assert.ok(!urls.some((u) => /contact|login|\.jpg/.test(u)));
  assert.equal(new Set(urls).size, urls.length, 'fragment variants are one link');
  assert.ok(links.length <= PAGE_FOLLOW_MAX_LINKS);
  assert.equal(extractFollowLinks(html, 'not a url').length, 0);
}

// 4. End to end: a landing page links to a history page; the history text is added as an extra result with substance.
{
  const landing = page(
    para(`${TOPIC} is the Chinese language society of Universiti Malaya, and this site is its official home page.`),
    '<a href="/about/history">History of the society</a><a href="https://ads.example.com/history">Ad</a>',
  );
  const history = page(
    para('The society was registered by a small circle of undergraduates who wanted a home for Chinese language and culture on campus.')
    + para('Over the following decades it added calligraphy classes, a literary journal and annual charity drives for rare disease patients.')
    + para('A rotating committee of volunteers still plans the calendar of events during the first weeks of each academic year, and members describe the annual cultural festival as the occasion that brings the widest range of faculties together.'),
  );
  const fetched: string[] = [];
  const out = await enrichResultsWithPageExcerpts([result('https://pbcum.org/', 'Home')], TOPIC, {
    fetchImpl: async (url) => {
      fetched.push(url);
      return htmlResponse(url.endsWith('/about/history') ? history : landing);
    },
  });
  assert.deepEqual(fetched, ['https://pbcum.org/', 'https://pbcum.org/about/history']);
  assert.equal(out.length, 2);
  assert.equal(out[0].url, 'https://pbcum.org/', 'original results keep their place');
  assert.match(out[1].excerpt || '', /calligraphy classes/);
  assert.equal(out[1].title, 'History of the society');
  assert.ok(!fetched.some((u) => u.includes('ads.example.com')));
}

// 5. A fetch that fails or hangs never throws and never loses a result.
{
  const out = await enrichResultsWithPageExcerpts([result('https://a.example.org/x'), result('https://b.example.org/y')], TOPIC, {
    fetchImpl: async (url) => { if (url.includes('a.example')) throw new Error('boom'); return new Response('nope', { status: 503 }); },
  });
  assert.equal(out.length, 2);
  assert.ok(out.every((r) => !r.excerpt));
}

// 6. Consolidation: reliable sources lead, low-reliability text is left out when reliable evidence suffices, paragraphs stay
//    within one source, and every chapter has real substance.
{
  const subjects = ['calligraphy workshop', 'debate league', 'alumni dinner', 'lion dance troupe', 'newsletter archive', 'library collection', 'charity drive', 'orientation camp', 'scholarship fund', 'drama production', 'language clinic', 'media team'];
  const clauses = ['was reorganised after a long committee discussion about volunteers', 'attracts first-year students from several faculties each semester', 'keeps printed records in the society office for reference', 'raised money that was shared with local community groups', 'trains new members through weekly sessions with senior mentors', 'partners with lecturers from the department of Chinese studies', 'collects feedback through surveys reviewed every term', 'depends on sponsors who renew their support every year'];
  const body = (tag: string, n: number, count: number) => Array.from({ length: count }, (_, i) => `${tag} reports that the ${subjects[(i * 5 + n) % 12]} ${clauses[(i * 3 + n) % 8]}.`).join(' ');
  const mk = (n: number, tag: string, url: string, count = 8) => ({
    id: `r-${n}`, title: `${tag} page`, url, content: body(tag, n, count),
    definitions: [], subTopics: [], informativeScore: 0.9, authorityScore: 0.9, fitness: 0,
  });

  const pool = [
    mk(1, 'Spamco', 'https://www.facebook.com/pbcum'),            // listed first, but low reliability
    mk(2, 'Blogger', 'https://some-blog.example.com/post'),
    mk(3, 'Encyclo', 'https://en.wikipedia.org/wiki/PBCUM'),
    mk(4, 'Society', 'https://pbcum.org/history'),
  ];
  const book = synthesizeFallbackWebBook(TOPIC, pool as any);
  const text = book.chapters.map((c) => c.content).join('\n');

  assert.ok(!/Spamco/.test(text), 'low-reliability text is left out when reliable evidence is enough');
  assert.match(book.generationNote || '', /Compiled offline from 3 sources/);
  assert.match(book.generationNote || '', /low-reliability/);
  assert.ok(book.chapters[0].content.startsWith('Encyclo'), `most reliable source leads, got: ${book.chapters[0].content.slice(0, 40)}`);
  assert.ok(book.chapters.length >= 2);

  for (const chapter of book.chapters) {
    assert.ok(countWords(chapter.content) >= 80, `chapter "${chapter.title}" has only ${countWords(chapter.content)} words`);
    assert.ok(chapter.content.split(/(?<=[.!?])\s+/).length >= 4);
    for (const paragraph of chapter.content.split(/\n\n/)) {
      const tags = new Set(paragraph.match(/(?:Encyclo|Blogger|Society|Spamco) reports/g));
      assert.equal(tags.size, 1, `a paragraph must come from one source: ${paragraph.slice(0, 80)}`);
    }
  }
  const sentences = book.chapters.flatMap((c) => c.content.split(/(?<=[.!?])\s+/));
  assert.equal(new Set(sentences).size, sentences.length, 'no sentence repeats');

  // Only low-reliability evidence available: it is used rather than producing an empty book, and nothing is claimed as left out.
  const only = synthesizeFallbackWebBook(TOPIC, [mk(5, 'Spamco', 'https://www.facebook.com/pbcum')] as any);
  assert.ok(only.chapters.length >= 1);
  assert.match(only.chapters.map((c) => c.content).join(' '), /Spamco reports/);
  assert.doesNotMatch(only.generationNote || '', /left out/);

  // Too little text for a real chapter is one chapter, not several captions.
  const tiny = synthesizeFallbackWebBook(TOPIC, [mk(6, 'Encyclo', 'https://en.wikipedia.org/wiki/PBCUM', 5)] as any);
  assert.equal(tiny.chapters.length, 1);
}

// 7. Live-run regressions: wiki revision pages, off-topic parents, stub pages, menu-label titles, three-sentence chapters.
{
  // Wikipedia / MediaWiki system pages are not an account of the subject.
  const wikiHtml = page(
    para('x'.repeat(10)),
    [
      '<a href="/w/index.php?title=PBCUM&amp;action=history">Lihat sejarah</a>',
      '<a href="/w/index.php?title=PBCUM&amp;oldid=123">History revision</a>',
      '<a href="/wiki/Special:History/PBCUM">View history</a>',
      '<a href="/wiki/Perbincangan:PBCUM">Talk history</a>',
      '<a href="/wiki/History_of_the_society">History of the society</a>',
    ].join(''),
  );
  const wikiLinks = extractFollowLinks(wikiHtml, 'https://ms.wikipedia.org/wiki/PBCUM').map((l) => l.url);
  assert.deepEqual(wikiLinks, ['https://ms.wikipedia.org/wiki/History_of_the_society'], 'only the real article link survives');

  // A page that only shares "Universiti Malaya" with the topic (a faculty page) must not have its links followed.
  const facultyHtml = page(
    para('The Faculty of Arts and Social Sciences at Universiti Malaya offers programmes in languages, history and the social sciences to undergraduates.'),
    '<a href="/overview">Overview</a>',
  );
  const fetchedFaculty: string[] = [];
  await enrichResultsWithPageExcerpts([result('https://fass.example.edu.my/chinese-studies', 'Department of Chinese Studies')], TOPIC, {
    fetchImpl: async (url) => { fetchedFaculty.push(url); return htmlResponse(facultyHtml); },
  });
  assert.deepEqual(fetchedFaculty, ['https://fass.example.edu.my/chinese-studies'], 'off-topic parent: no link following');

  // A followed page that is only a stub is not added.
  const parent = page(para(`${TOPIC} is the Chinese language society of Universiti Malaya and this is its official site for members.`), '<a href="/about/history">History</a>');
  const stub = page(para('Founded in 1962 by a small circle of students on campus.'));
  const out = await enrichResultsWithPageExcerpts([result('https://pbcum.org/', 'Home')], TOPIC, {
    fetchImpl: async (url) => htmlResponse(url.endsWith('/about/history') ? stub : parent),
  });
  assert.equal(out.length, 1, 'a stub page is not added as a source');
}

{
  // Menu labels are never chapter titles (English, Chinese and Malay).
  for (const title of ['联系我们', 'Contact Us', 'Overview', 'Hubungi Kami', '关于我们', 'Menu']) {
    assert.equal(cleanSourceTitle(title, 'https://example.wordpress.com/x'), '', title);
  }
  assert.equal(cleanSourceTitle('学会简史', 'https://example.wordpress.com/x'), '学会简史');

  // Chapters never fall below four sentences even when each sentence is long enough to reach the word floor.
  const subjects = ['书法工作坊', '辩论联赛', '校友联谊晚宴', '舞狮训练团', '会讯编辑小组', '图书角藏书', '慈善义卖活动', '迎新营队', '奖学金基金', '戏剧演出组', '语文辅导班', '媒体宣传组'];
  const actions = ['在多位资深成员的协助下完成了全年的课程规划，并把每次课堂的出席情况记录在册以便日后查阅', '吸引了来自不同学院的新生报名参加，筹备委员会因此额外增加了两次说明会来解答大家的疑问', '依靠志愿者分工合作安排场地与器材，整个过程由一位副主席负责统筹并向理事会提交书面总结', '把筹得的款项分别捐给了数个社区团体，并邀请受助单位代表出席年度汇报会向会员说明用途', '每学期都会向参与者收集意见调查，委员会逐项讨论后决定下一阶段需要改进的具体环节'];
  const longSentence = (tag: string, i: number) => `${tag}${subjects[i % 12]}${actions[(i * 2 + tag.length) % 5]}。`;
  const source = (n: number, tag: string, url: string, count: number) => ({
    id: `c-${n}`, title: `${tag}`, url, content: Array.from({ length: count }, (_, i) => longSentence(`${tag}${'甲乙丙丁戊己庚辛'[(i + n) % 8]}`, i + n * 7)).join(''),
    definitions: [], subTopics: [], informativeScore: 0.9, authorityScore: 0.9, fitness: 0,
  });
  const book = synthesizeFallbackWebBook('马来亚大学华文学会', [
    source(1, '甲站', 'https://en.wikipedia.org/wiki/A', 9),
    source(2, '乙站', 'https://pbcum.org/b', 9),
    source(3, '丙站', 'https://example.edu.my/c', 3),
  ] as any);
  assert.ok(book.chapters.length >= 1);
  for (const chapter of book.chapters) {
    const sentenceCount = chapter.content.split(/(?<=[。！？.!?])/).filter((x) => x.trim()).length;
    assert.ok(sentenceCount >= 4, `chapter "${chapter.title}" has only ${sentenceCount} sentences`);
  }
}

console.log('offlineReliability tests passed');
