import assert from 'node:assert/strict';
import {
  GEMINI_REQUEST_TIMEOUT_MS,
  buildGeminiUserFacingErrorMessage,
} from '../../src/services/geminiUserFacingErrors.ts';
import { hasUsableFallbackPayloadEvidence } from '../../src/services/fallbackPayloadHeuristics.ts';
import { parseSearchExtractionResponse } from '../../src/services/searchIntakeParser.ts';
import {
  normalizeSourceLink,
  reduceRepeatedChapterSourceReferences,
  sanitizeNarrativeText,
  sanitizeStructuredLabel,
  sanitizeWebBookForPresentation,
} from '../../src/utils/webBookRender.ts';
import { synthesizeFallbackWebBook } from '../../src/services/evolutionService.ts';

assert.equal(
  GEMINI_REQUEST_TIMEOUT_MS,
  0,
  'Gemini requests should not be aborted by a hardcoded local timeout.'
);

const invalidApiKeyPayload = JSON.stringify({
  error: {
    code: 400,
    message: 'API key not valid. Please pass a valid API key.',
    status: 'INVALID_ARGUMENT',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
        reason: 'API_KEY_INVALID',
        domain: 'googleapis.com',
      },
    ],
  },
});

assert.equal(
  buildGeminiUserFacingErrorMessage(new Error(invalidApiKeyPayload), 'invalid_api_key'),
  'Gemini API key was rejected by Google. Check GEMINI_API_KEY or VITE_GEMINI_API_KEY and try again.\n\nDetails: API key not valid. Please pass a valid API key.'
);

const jsonSearchIntake = JSON.stringify([
  {
    url: 'https://example.com/json-source',
    title: 'JSON Source',
    content: 'JSON intake content with enough detail to remain meaningful.',
    definitions: [{ term: 'JSON term', description: 'Structured definition.' }],
    subTopics: [{ title: 'JSON subtopic', summary: 'Structured summary.' }],
    informativeScore: 0.84,
    authorityScore: 0.81,
  },
]);

assert.equal(
  parseSearchExtractionResponse(jsonSearchIntake, 'JSON intake should parse.')[0].url,
  'https://example.com/json-source'
);

const xmlSearchIntake = `
<sources>
  <source>
    <url>https://example.com/xml-source</url>
    <title>XML Source</title>
    <content>XML intake content with grounded detail for the parser.</content>
    <definitions>
      <definition>
        <term>XML term</term>
        <description>XML definition text.</description>
      </definition>
    </definitions>
    <subTopics>
      <subtopic>
        <title>XML subtopic</title>
        <summary>XML subtopic summary.</summary>
      </subtopic>
    </subTopics>
    <informativeScore>0.79</informativeScore>
    <authorityScore>0.77</authorityScore>
  </source>
</sources>
`;

const parsedXmlSearchIntake = parseSearchExtractionResponse(xmlSearchIntake, 'XML intake should parse.');
assert.equal(parsedXmlSearchIntake[0].title, 'XML Source');
assert.equal(parsedXmlSearchIntake[0].definitions[0].term, 'XML term');
assert.equal(parsedXmlSearchIntake[0].subTopics[0].title, 'XML subtopic');

const htmlSearchIntake = `
<div class="sources">
  <article class="source">
    <h2>HTML Source</h2>
    <a href="https://example.com/html-source">Read source</a>
    <p>HTML intake content with enough detail to survive markup stripping.</p>
    <p>Additional supporting context keeps the summary rich.</p>
  </article>
</div>
`;

const parsedHtmlSearchIntake = parseSearchExtractionResponse(htmlSearchIntake, 'HTML intake should parse.');
assert.equal(parsedHtmlSearchIntake[0].title, 'HTML Source');
assert.equal(parsedHtmlSearchIntake[0].url, 'https://example.com/html-source');
assert.match(parsedHtmlSearchIntake[0].content, /HTML intake content/i);

const rawTextSearchIntake = `
URL: https://example.com/raw-source
Title: Raw Text Source
Content: Raw text intake content that should be accepted without JSON wrapping.
Definitions:
- Raw concept: Raw definition text.
SubTopics:
- Raw angle: Raw subtopic summary.
InformativeScore: 0.74
AuthorityScore: 0.71
`;

const parsedRawTextSearchIntake = parseSearchExtractionResponse(rawTextSearchIntake, 'Raw text intake should parse.');
assert.equal(parsedRawTextSearchIntake[0].title, 'Raw Text Source');
assert.equal(parsedRawTextSearchIntake[0].definitions[0].term, 'Raw concept');
assert.equal(parsedRawTextSearchIntake[0].subTopics[0].title, 'Raw angle');

const multiBlockRawTextSearchIntake = `
Link: https://example.com/raw-source-a
Title: Raw Text Source A
Content: First raw text block with enough detail to remain meaningful.

URI: https://example.com/raw-source-b
Title: Raw Text Source B
Content: Second raw text block with enough detail to remain meaningful.
`;

const parsedMultiBlockRawTextSearchIntake = parseSearchExtractionResponse(multiBlockRawTextSearchIntake, 'Multi-block raw text intake should parse.');
assert.equal(parsedMultiBlockRawTextSearchIntake.length, 2);
assert.equal(parsedMultiBlockRawTextSearchIntake[1].url, 'https://example.com/raw-source-b');

// Regression: fenced JSON with trailing text causes stripStructuredResponseFence to fail,
// so the raw-text parser fires. The literal string "```json" must never become a chapter
// title or appear in exported chapter headings (VISUAL CONCEPT / CHAPTER N fields).
const fencedJsonWithTrailingText = `\`\`\`json
[{
  "url": "https://example.com/fenced-source",
  "title": "Fenced Source",
  "content": "Fenced intake content that is meaningful and has enough detail to pass validation.",
  "definitions": [{ "term": "Fenced term", "description": "Fenced definition." }],
  "subTopics": [{ "title": "Fenced subtopic", "summary": "Fenced summary." }],
  "informativeScore": 0.80,
  "authorityScore": 0.78
}]
\`\`\`
Some extra trailing text that prevents the closing fence from being at end-of-string.`;

const parsedFencedWithTrailing = parseSearchExtractionResponse(fencedJsonWithTrailingText, 'Fenced JSON with trailing text should parse.');
assert.notEqual(
  parsedFencedWithTrailing[0].title,
  '```json',
  'A code-fence marker must never become a source title.'
);
assert.ok(
  parsedFencedWithTrailing[0].content && parsedFencedWithTrailing[0].content.length > 0,
  'Content must be non-empty even when the fence is not cleanly closed.'
);

assert.equal(
  sanitizeStructuredLabel('[', 'Chapter 2'),
  'Chapter 2',
  'A single bracket must never survive as a chapter title.'
);

assert.equal(
  sanitizeStructuredLabel('Chapter 1: 成立渊源与创会宗旨', 'Chapter 1'),
  'Chapter 1: 成立渊源与创会宗旨',
  'A chapter title prefixed with Chapter 1: must not be discarded as metadata.'
);
assert.equal(
  sanitizeStructuredLabel('CHAPTER 1: Origins and History', 'Chapter 1'),
  'CHAPTER 1: Origins and History',
  'An English chapter title prefixed with CHAPTER 1: must not be discarded.'
);
assert.equal(
  sanitizeStructuredLabel('CHAPTER 1:', 'Chapter 1'),
  'Chapter 1',
  'A bare chapter header without title text must fall back to the fallback title.'
);
assert.equal(
  sanitizeStructuredLabel('CHAPTER 1', 'Chapter 1'),
  'Chapter 1',
  'A bare chapter label without title text must fall back to the fallback title.'
);

const contaminatedNarrative = `[ { "url": "https://example.com/raw-source", "title": "Raw Source", "content": "Structured blob that should not survive into chapter prose." } ]

VISUAL CONCEPT: Raw Source

CORE CONCEPTS:
- Raw Source: https://example.com/raw-source

SOURCES:
- Raw Source - https://example.com/raw-source`;

assert.equal(
  sanitizeNarrativeText(contaminatedNarrative),
  '',
  'Structured JSON/export artifacts should be stripped from chapter prose instead of leaking into exports.'
);

const urlAndTimestampNoise = `www.sciencedirect.com/science/article/pii/S2949882125000167 2025-05-01T00:00:00.0000000 ailiteracy.institute/ai-literacy-review-march-11-2025/ 2025-03-11T00:00:00.0000000
Coverage of US VS UK on public AI Literacy often connects AI Literacy and classroom practice.
Public AI literacy debates now focus on which skills schools should teach and how those skills are assessed.`;

assert.equal(
  sanitizeNarrativeText(urlAndTimestampNoise),
  'Public AI literacy debates now focus on which skills schools should teach and how those skills are assessed.',
  'Standalone URL/timestamp dump lines and generic fallback bridge copy should be removed from chapter prose.'
);

const comparativeDomainNarrative = `Placed beside one another, sources from wikipedia.org, britannica.com, and state.gov keep returning to geography and history. That overlap suggests a shared core narrative around Malaysia, even as each source contributes its own mix of detail, framing, and emphasis.`;

assert.equal(
  sanitizeNarrativeText(comparativeDomainNarrative),
  comparativeDomainNarrative,
  'Comparative narrative sentences that cite multiple domains should survive prose sanitization.'
);

const urlDumpWithGenericSynthesis = `en.wikipedia.org/wiki/Indonesia en.wikipedia.org/wiki/Indonesia www.fao.org/indonesia/about-us/indonesia-at-a-glance/en www.countryreports.org/country/Indonesia.htm Overall, the available search evidence keeps indonesia - wikipedia connected to Indonesia, Indonesia at a glance, and History of Indonesia within the broader story of Indonesia.`;

assert.equal(
  sanitizeNarrativeText(urlDumpWithGenericSynthesis),
  '',
  'URL dumps and generic synthesis filler should not survive into chapter prose.'
);

const urlDumpWithRealNarrative = `en.wikipedia.org/wiki/Indonesia www.fao.org/indonesia/about-us/indonesia-at-a-glance/en Indonesia is the world\'s largest archipelagic state and spans thousands of islands across Southeast Asia.`;

assert.equal(
  sanitizeNarrativeText(urlDumpWithRealNarrative),
  'Indonesia is the world\'s largest archipelagic state and spans thousands of islands across Southeast Asia.',
  'Inline URL clusters should be stripped while retaining a meaningful narrative sentence.'
);

const genericBridgeNarrative = `overview connected to Iran War Clock — Accountability Tracker within the broader story of When would Iran war be ended?. 2026-04-17T00:21:43.0000000 2026-03-10T17:30:00.0000000 The Iran War Clock tracks the live length of the US- Iran War and the official predictions from the Trump Administration about its end.`;

assert.equal(
  sanitizeNarrativeText(genericBridgeNarrative),
  'The Iran War Clock tracks the live length of the US- Iran War and the official predictions from the Trump Administration about its end.',
  'Title-fragment fallback bridge sentences should be dropped while keeping the real narrative that follows them.'
);

const promotionalFallbackNarrative = `Through our website, you can apply for the e-Visa application form online in a convenient way without having to go to apply in the Indonesia embassy on your own.`;

assert.equal(
  sanitizeNarrativeText(promotionalFallbackNarrative),
  '',
  'Transactional promotional fallback copy should not survive into chapter prose.'
);

const inlineHeadingNarrative = `Reference comparison across docs.
Definitions: This line starts a legitimate section from the source page.
The next sentence has real explanatory detail.`;

assert.equal(
  sanitizeNarrativeText(inlineHeadingNarrative),
  'Reference comparison across docs. The next sentence has real explanatory detail.',
  'Inline heading words should not cause the rest of the narrative paragraph to be discarded.'
);

const sanitizedBook = sanitizeWebBookForPresentation({
  id: 'book-test',
  topic: 'Sample WebBook',
  timestamp: Date.now(),
  chapters: [
    {
      title: '[',
      content: contaminatedNarrative,
      definitions: [],
      subTopics: [],
      sourceUrls: [],
      visualSeed: '[',
    },
    {
      title: 'Practical Context',
      content: urlAndTimestampNoise,
      definitions: [],
      subTopics: [],
      sourceUrls: [{ title: '[', url: 'https://example.com/raw-source' }],
      visualSeed: 'AI literacy',
    },
  ],
});

assert.equal(
  sanitizedBook.chapters.length,
  1,
  'Chapters that collapse into pure structured noise should be removed before render/export.'
);
assert.equal(sanitizedBook.chapters[0].title, 'Practical Context');
assert.equal(
  sanitizedBook.chapters[0].content,
  'Public AI literacy debates now focus on which skills schools should teach and how those skills are assessed.'
);
assert.equal(
  typeof sanitizedBook.chapters[0].sourceUrls[0] === 'string'
    ? sanitizedBook.chapters[0].sourceUrls[0]
    : sanitizedBook.chapters[0].sourceUrls[0].title,
  'https://example.com/raw-source',
  'Malformed source titles should fall back to the URL instead of leaking bracket artifacts.'
);

const prefixedChaptersBook = sanitizeWebBookForPresentation({
  id: 'book-prefix-test',
  topic: '马来亚大学新青年学会',
  timestamp: Date.now(),
  chapters: [
    {
      title: 'Chapter 1: 成立渊源与创会宗旨',
      content: '马来亚大学新青年学会的创会历史与早期学术自由斗争背景。',
      definitions: [],
      subTopics: [],
      sourceUrls: [],
      visualSeed: '成立渊源与创会宗旨',
    },
    {
      title: 'Chapter 10: 未来挑战与新世代青年愿景',
      content: '面向未来发展的战略展望与社会责任实践分析。',
      definitions: [],
      subTopics: [],
      sourceUrls: [],
      visualSeed: '未来挑战与新世代青年愿景',
    },
    {
      title: 'Chapter 3',
      content: '无副标题的纯序号章节保留原序号。',
      definitions: [],
      subTopics: [],
      sourceUrls: [],
      visualSeed: 'Chapter 3',
    },
  ],
});

assert.equal(prefixedChaptersBook.chapters[0].title, '成立渊源与创会宗旨', 'Redundant Chapter 1: prefix is cleanly stripped to leave real title');
assert.equal(prefixedChaptersBook.chapters[1].title, '未来挑战与新世代青年愿景', 'Redundant Chapter 10: prefix is cleanly stripped to leave real title');
assert.equal(prefixedChaptersBook.chapters[2].title, 'Chapter 3', 'Bare Chapter 3 retains chapter number when no subtitle exists');

assert.equal(
  normalizeSourceLink({
    title: 'https://en.wikipedia.org/wiki/Indonesia',
    url: 'https://en.wikipedia.org/wiki/Indonesia',
  })?.title,
  'wikipedia',
  'Display titles for source links should fall back to a readable host label instead of a raw URL.'
);

const cumulativeSnippetFallbackPayload = {
  query: 'Basic Topic',
  source: 'google-search-snippets' as const,
  provider: 'google' as const,
  summary: 'Brief topic overview.',
  aiOverview: [],
  results: [
    {
      title: 'Foundational Concepts',
      url: 'https://example.com/foundations',
      domain: 'example.com',
      snippet: 'Basic explainers describe the topic in clear terms and connect its vocabulary to the larger field.',
    },
    {
      title: 'Practical Context',
      url: 'https://example.org/context',
      domain: 'example.org',
      snippet: 'Reference material adds real world context, common examples, and the reasons the topic keeps appearing in introductions for new readers and students.',
    },
  ],
  extractedAt: 1,
};

assert.equal(
  hasUsableFallbackPayloadEvidence(cumulativeSnippetFallbackPayload),
  true,
  'Several shorter fallback snippets should count as usable evidence when they add up to enough meaningful content.'
);

const repeatedSourceCounts = reduceRepeatedChapterSourceReferences([
  {
    title: 'Shared references opening',
    content: 'Meaningful narrative content for the opening chapter.',
    definitions: [],
    subTopics: [],
    sourceUrls: [
      { title: 'Alpha', url: 'https://alpha.example.org' },
      { title: 'Beta', url: 'https://beta.example.org' },
      { title: 'Gamma', url: 'https://gamma.example.org' },
    ],
    visualSeed: 'alpha',
  },
  {
    title: 'Second chapter',
    content: 'Meaningful narrative content for the second chapter.',
    definitions: [],
    subTopics: [],
    sourceUrls: [
      { title: 'Alpha duplicate', url: 'https://alpha.example.org' },
      { title: 'Delta', url: 'https://delta.example.org' },
      { title: 'Gamma duplicate', url: 'https://gamma.example.org' },
    ],
    visualSeed: 'delta',
  },
  {
    title: 'Third chapter',
    content: 'Meaningful narrative content for the third chapter.',
    definitions: [],
    subTopics: [],
    sourceUrls: [
      { title: 'Beta duplicate', url: 'https://beta.example.org' },
      { title: 'Epsilon', url: 'https://epsilon.example.org' },
      { title: 'Delta duplicate', url: 'https://delta.example.org' },
    ],
    visualSeed: 'epsilon',
  },
]).reduce((counts, chapter) => {
  chapter.sourceUrls.forEach((source) => {
    const url = typeof source === 'string' ? source : source.url;
    counts.set(url, (counts.get(url) || 0) + 1);
  });
  return counts;
}, new Map<string, number>());

assert.equal(
  [...repeatedSourceCounts.values()].some((count) => count > 1),
  false,
  'Fallback chapter source trails should prefer fresh URLs across the book instead of repeating the same link on multiple pages.'
);

// Verify synthesizeFallbackWebBook directly on a multi-source pool:
// 1. Synthesizes full 6 chapters when supplied with diverse evidence across 12 distinct pages.
// 2. Every sentence in the generated webbook across chapters is unique.
// 3. Near-duplicate sentences are filtered out by similarity deduplication.
// 4. All 12 source URLs are cited in the book's chapter source lists according to narrative evidence usage.
// 5. Definitions and subtopics land in the chapter that cites their source URL.
const topics = [
  'subsidy reform',
  'coalition talks',
  'fiscal policy',
  'state elections',
  'youth turnout',
  'rural voting',
  'urban sentiment',
  'party funding',
  'judicial review',
  'federal transfers',
  'oil royalties',
  'tax collection',
];

const samplePages = topics.map((t, i) => ({
  id: `page-${i + 1}`,
  title: `Analysis Page ${i + 1}`,
  url: `https://news-outlet-${i + 1}.org/article-${i + 1}`,
  // Four genuinely different sentences per page: six chapters need real substance (four or more sentences each), and the
  // engine rightly drops sentences that only swap one topic word.
  content: `Analysts say ${t} will shape political debates across parliamentary constituencies in Malaysia. Observers expect ${topics[(i + 5) % 12]} to remain a central economic topic before elections. ${['Treasury officials','Opposition strategists','Regional governors','Union leaders','Campus organisers','Farm cooperatives','City planners','Donor committees','Senior judges','State secretaries','Petroleum executives','Revenue inspectors'][i]} published a ${['detailed schedule','twelve-page memo','joint statement','costed proposal','survey summary','voter guide','spending review','audit report','legal opinion','budget annex','pricing study','compliance note'][i]} on ${t} that circulated widely during ${['March','April','May','June','July','August','September','October','November','December','January','February'][i]}. Reporters in ${['Penang','Johor','Sabah','Sarawak','Kelantan','Perak','Selangor','Kedah','Melaka','Pahang','Terengganu','Perlis'][i]} compared those figures with ${['last decade','the previous term','pre-pandemic levels','neighbouring states','regional averages','census data','central bank forecasts','university research','independent polling','ministry estimates','industry filings','parliamentary answers'][i]} before drawing conclusions.`,
  definitions: [
    {
      term: `Concept ${t}`,
      description: `Grounded definition explaining key mechanics of ${t}.`,
      sourceUrl: `https://news-outlet-${i + 1}.org/article-${i + 1}`,
    },
  ],
  subTopics: [
    {
      title: `Subtopic ${t}`,
      summary: `Detailed summary covering tactical policy implications of ${t}.`,
      sourceUrl: `https://news-outlet-${i + 1}.org/article-${i + 1}`,
    },
  ],
  informativeScore: 0.9,
  authorityScore: 0.9,
}));

// Add one deliberate near-duplicate page to confirm similarity deduplication drops near-duplicate sentences
samplePages.push({
  id: 'page-duplicate',
  title: 'Duplicate Analysis Page',
  url: 'https://news-outlet-dup.org/article-dup',
  content: 'Analysts say subsidy reform will shape political debates across parliamentary constituencies in Malaysia.',
  definitions: [],
  subTopics: [],
  informativeScore: 0.9,
  authorityScore: 0.9,
});

const synthesizedBook = synthesizeFallbackWebBook('Malaysia Political Landscape', samplePages as any);

assert.equal(synthesizedBook.chapters.length, 6, 'Fallback webbook should generate 6 distinct chapters when given sufficient evidence.');

const allSentences = new Set<string>();
let totalSentencesCount = 0;

synthesizedBook.chapters.forEach((chapter) => {
  const chapterSentences = chapter.content.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
  chapterSentences.forEach((sentence) => {
    totalSentencesCount++;
    allSentences.add(sentence.trim());
  });

  // Verify definitions and subtopics in this chapter match the sources cited by this chapter
  const chapterSourceUrls = new Set(chapter.sourceUrls.map((s) => (typeof s === 'string' ? s : s.url)));
  chapter.definitions.forEach((def) => {
    if (def.sourceUrl) {
      assert.ok(
        chapterSourceUrls.has(def.sourceUrl),
        `Definition "${def.term}" in chapter "${chapter.title}" placed without citing its source URL ${def.sourceUrl}`
      );
    }
  });
  chapter.subTopics.forEach((st) => {
    if (st.sourceUrl) {
      assert.ok(
        chapterSourceUrls.has(st.sourceUrl),
        `SubTopic "${st.title}" in chapter "${chapter.title}" placed without citing its source URL ${st.sourceUrl}`
      );
    }
  });
});

assert.equal(
  allSentences.size,
  totalSentencesCount,
  'Every sentence in the synthesized webbook must be unique across all chapters.'
);

assert.equal(
  totalSentencesCount,
  48,
  `Synthesized webbook should yield exactly 48 distinct sentences (12 pages x 4) across 6 chapters (got ${totalSentencesCount}).`
);

const citedUrls = new Set(
  synthesizedBook.chapters.flatMap((c) => c.sourceUrls.map((s) => (typeof s === 'string' ? s : s.url)))
);
assert.equal(citedUrls.size, 12, 'All 12 distinct evidence sources must be cited across the webbook chapters.');
assert.ok(!citedUrls.has('https://news-outlet-dup.org/article-dup'), 'Near-duplicate page should be deduplicated out and not cited.');

// Additional test case: Verify that a chapter drawing on >3 sources is NOT capped at 3 sources
const multiSourceSentences = [
  'Subsidy restructuring realignment reduces state fiscal overheads considerably.',
  'Coalition negotiations dictate parliamentary majority stability for legislative agendas.',
  'Fiscal reforms stabilize sovereign credit standing across global rating agencies.',
  'State assembly elections indicate shifting voter sentiment across rural demographics.',
  'Youth voter participation increases electoral volatility in urban seats.',
  'Rural constituency boundaries rebalance seat allocation across federal states.',
  'Urban sentiment reflects inflation concerns and cost of living pressure points.',
  'Political financing legislation regulates corporate campaign donations transparently.',
  'Judicial review rulings maintain constitutional separation of powers effectively.',
  'Federal fiscal transfers support state infrastructure development budgets equally.',
  'Petroleum royalty distribution agreements impact state revenue allocation models.',
  'Tax collection efficiency improves under modernized digital compliance systems.',
  'Inflation targeting policies balance price stability with economic growth momentum.',
  'Infrastructure investment accelerates regional connectivity projects across corridors.',
  'Export competitiveness relies on currency valuation stability and port efficiency.',
  'Labor market reforms address wage stagnation and youth underemployment rates.',
  'Renewable energy transition incentives drive green economy capital investment.',
  'Digital economy regulatory frameworks foster technology startup ecosystem expansion.',
  'Healthcare expenditure expansion improves rural clinic access and medical supply.',
  'Education curriculum modernization enhances technical workforce skill readiness.',
  'Agricultural subsidy targets ensure food security across vulnerable communities.',
  'Social safety net programs mitigate household economic vulnerability nationwide.',
  'Decentralization initiatives grant regional authorities broader fiscal autonomy.',
  'Public sector governance reforms reduce administrative overhead and bureaucracy.',
];

const multiSourcePages = multiSourceSentences.map((sentence, i) => ({
  id: `ms-page-${i + 1}`,
  title: `Multi-Source Page ${i + 1}`,
  url: `https://multi-ref-outlet-${i + 1}.org/article-${i + 1}`,
  content: sentence,
  definitions: [],
  subTopics: [],
  informativeScore: 0.9,
  authorityScore: 0.9,
}));

const multiSourceBook = synthesizeFallbackWebBook('Malaysia Governance Overview', multiSourcePages as any);
// 24 one-line sentences are about 220 words: enough for two substantial chapters (80+ words each), not six thin ones.
assert.equal(multiSourceBook.chapters.length, 2, 'Multi-source synthesis must size chapters to the evidence (2 chapters of 12 sentences).');
const maxListedSources = Math.max(...multiSourceBook.chapters.map((c) => c.sourceUrls.length));
assert.ok(
  maxListedSources > 3,
  `A chapter drawing on >3 sources must list all contributing sources without an artificial 3-source cap (max listed was ${maxListedSources}).`
);
assert.ok(
  multiSourceBook.chapters.every((c) => c.sourceUrls.length === 12),
  'Every chapter in the 24-sentence multi-source synthesis must list all 12 of its contributing sources.'
);

// Verify duplicate ordering precedence: earlier page in source pool is retained, later duplicate is dropped
const dupFirstPages = [
  {
    id: 'page-earlier',
    title: 'Earlier Page',
    url: 'https://news-outlet-earlier.org/article-1',
    content: 'Subsidy restructuring realignment reduces state fiscal overheads considerably.',
    definitions: [],
    subTopics: [],
    informativeScore: 0.9,
    authorityScore: 0.9,
  },
  {
    id: 'page-later',
    title: 'Later Page',
    url: 'https://news-outlet-later.org/article-2',
    content: 'Subsidy restructuring realignment reduces state fiscal overheads considerably.',
    definitions: [],
    subTopics: [],
    informativeScore: 0.9,
    authorityScore: 0.9,
  },
];
const dupFirstBook = synthesizeFallbackWebBook('Malaysia Fiscal Policy', dupFirstPages as any);
const dupFirstCitedUrls = new Set(
  dupFirstBook.chapters.flatMap((c) => c.sourceUrls.map((s) => (typeof s === 'string' ? s : s.url)))
);
assert.ok(dupFirstCitedUrls.has('https://news-outlet-earlier.org/article-1'), 'Earlier duplicate page should be retained.');
assert.ok(!dupFirstCitedUrls.has('https://news-outlet-later.org/article-2'), 'Later duplicate page should be dropped.');

// Verify earlier page retained over a later longer duplicate page
const dupLaterLongerPages = [
  {
    id: 'page-earlier-short',
    title: 'Earlier Page Short',
    url: 'https://news-outlet-earlier-short.org/article-1',
    content: 'Subsidy restructuring realignment reduces state fiscal overheads considerably.',
    definitions: [],
    subTopics: [],
    informativeScore: 0.9,
    authorityScore: 0.9,
  },
  {
    id: 'page-later-long',
    title: 'Later Page Long',
    url: 'https://news-outlet-later-long.org/article-2',
    content: 'Subsidy restructuring realignment reduces state fiscal overheads considerably. Additional secondary sentence for the longer page.',
    definitions: [],
    subTopics: [],
    informativeScore: 0.9,
    authorityScore: 0.9,
  },
];
const dupLaterLongerBook = synthesizeFallbackWebBook('Malaysia Fiscal Policy', dupLaterLongerPages as any);
const dupLaterLongerCitedUrls = new Set(
  dupLaterLongerBook.chapters.flatMap((c) => c.sourceUrls.map((s) => (typeof s === 'string' ? s : s.url)))
);
assert.ok(
  dupLaterLongerCitedUrls.has('https://news-outlet-earlier-short.org/article-1'),
  'Earlier duplicate page should be retained regardless of length.'
);
assert.ok(
  dupLaterLongerCitedUrls.has('https://news-outlet-later-long.org/article-2'),
  'Later page should still be cited for its own unique sentence.'
);

import { isValidConceptDefinition } from '../../src/services/searchFallbackShared.ts';

// Concept definition guard tests against news datelines and unbalanced brackets
assert.equal(
  isValidConceptDefinition('KUALA LUMPUR', 'Five years, five leaders.'),
  false,
  'All-caps news datelines must not become term definitions'
);
assert.equal(
  isValidConceptDefinition('Malaysia Madani (English', 'Civilised Malaysia) [1] is a framework.'),
  false,
  'Unbalanced parenthetical terms must be rejected'
);
assert.equal(
  isValidConceptDefinition('NASA', 'National Aeronautics and Space Administration is the US space agency.'),
  true,
  'Valid terms with description must pass'
);

console.log('evolutionService regression checks passed');
