import assert from 'node:assert/strict';
import { buildSearchQueryVariants, extractRequestedFallbackMode, parseRequestPayload, stripDatePhrasing } from '../../server/googleSearchFallback.ts';
import { normalizeComparableText } from '../../server/searchStrategies/shared.ts';
import { isGoogleBlockedPage } from '../../server/searchStrategies/googleStrategy.ts';
import { extractSearchResultsFromDuckDuckGoHtml } from '../../server/searchStrategies/duckDuckGoStrategy.ts';
import { buildFallbackOverviewTitle, buildFallbackSearchUrl } from '../../src/services/searchFallbackShared.ts';
import { isSearchFallbackReason } from '../../src/types.ts';

const legacyPopulation = [
  {
    title: 'Example source',
    content: 'A short but valid content body for the regression test.',
    url: 'https://example.com/source',
  },
];

assert.deepEqual(parseRequestPayload(JSON.stringify(legacyPopulation)), {
  population: legacyPopulation,
});

const objectPayload = {
  population: [
    {
      title: 'Existing payload shape',
      content: 'This should continue to pass through unchanged.',
      url: 'https://example.com/object-shape',
    },
  ],
  generations: 4,
};

assert.deepEqual(parseRequestPayload(JSON.stringify(objectPayload)), objectPayload);

assert.equal(
  extractRequestedFallbackMode(new URL('http://localhost/api/search-fallback?provider=duckduckgo'), {}),
  'duckduckgo'
);

assert.equal(
  extractRequestedFallbackMode(new URL('http://localhost/api/search-fallback?mode=off'), {}),
  'off'
);

assert.equal(
  extractRequestedFallbackMode(new URL('http://localhost/api/search-fallback'), { provider: 'duckduckgo' }),
  'duckduckgo'
);

assert.equal(
  extractRequestedFallbackMode(new URL('http://localhost/api/search-fallback?provider=invalid'), {}),
  'google_duckduckgo'
);

const duckDuckGoOnlyPayload = {
  query: 'Quantum Physics',
  mode: 'duckduckgo' as const,
  source: 'alternate-search-snippets' as const,
  provider: 'duckduckgo' as const,
  summary: 'DuckDuckGo summary',
  aiOverview: [],
  results: [
    {
      title: 'DuckDuckGo result',
      url: 'https://example.com/duckduckgo-result',
      domain: 'example.com',
      snippet: 'A fallback result from DuckDuckGo.',
    },
  ],
  extractedAt: 1,
  diagnostics: ['duckduckgo-results:1'],
};

assert.equal(
  buildFallbackOverviewTitle(duckDuckGoOnlyPayload),
  'Quantum Physics - DuckDuckGo Search Summary'
);

const duckDuckGoUrl = new URL(buildFallbackSearchUrl('Quantum Physics', 'duckduckgo'));
assert.equal(duckDuckGoUrl.hostname, 'duckduckgo.com');
assert.equal(duckDuckGoUrl.searchParams.get('q'), 'Quantum Physics');
assert.equal(duckDuckGoUrl.searchParams.get('ia'), 'web');

assert.equal(isSearchFallbackReason('network_unreachable'), true);
assert.equal(isSearchFallbackReason('not-a-reason'), false);

const normalGoogleResultsHtml = `
  <html>
    <body>
      <a href="/url?q=https://example.com/article">
        <h3>Example Search Result</h3>
      </a>
      <div>About this page</div>
      <div class="VwiC3b">
        This is a realistic search snippet that should not be mistaken for a
        Google anti-bot interstitial because it is part of a normal result page.
      </div>
    </body>
  </html>
`;

assert.equal(isGoogleBlockedPage(normalGoogleResultsHtml), false);

const blockedGoogleHtml = `
  <html>
    <body>
      Our systems have detected unusual traffic from your computer network.
      To continue, please type the characters below.
    </body>
  </html>
`;

assert.equal(isGoogleBlockedPage(blockedGoogleHtml), true);

// 1. Date stripping and query variant generation with bidirectional month/year ordering
{
  const yearFirstRange = 'Malaysia political landscape between 2026 Nov and 2028 Dec';
  assert.equal(stripDatePhrasing(yearFirstRange), 'Malaysia political landscape');
  const variantsYearFirst = buildSearchQueryVariants(yearFirstRange);
  assert.ok(variantsYearFirst.includes('Malaysia political landscape'));

  const monthFirstRange = 'Malaysia political landscape between Nov 2026 and Dec 2028';
  assert.equal(stripDatePhrasing(monthFirstRange), 'Malaysia political landscape');
  const variantsMonthFirst = buildSearchQueryVariants(monthFirstRange);
  assert.ok(variantsMonthFirst.includes('Malaysia political landscape'));

  const singleMonthFirst = 'Malaysia election in November 2026';
  assert.equal(stripDatePhrasing(singleMonthFirst), 'Malaysia election');
  assert.ok(buildSearchQueryVariants(singleMonthFirst).includes('Malaysia election'));

  const singleYearFirst = 'Malaysia election in 2026 November';
  assert.equal(stripDatePhrasing(singleYearFirst), 'Malaysia election');
  assert.ok(buildSearchQueryVariants(singleYearFirst).includes('Malaysia election'));

  const yearOnlyBetween = 'Malaysia political landscape between 2026 and 2028';
  assert.equal(stripDatePhrasing(yearOnlyBetween), 'Malaysia political landscape');
  assert.ok(buildSearchQueryVariants(yearOnlyBetween).includes('Malaysia political landscape'));

  const yearOnlyFromTo = 'Malaysia political landscape from 2026 to 2028';
  assert.equal(stripDatePhrasing(yearOnlyFromTo), 'Malaysia political landscape');
  assert.ok(buildSearchQueryVariants(yearOnlyFromTo).includes('Malaysia political landscape'));

  // Ordinary number ranges that are not calendar years should remain untouched
  const numberRange1 = 'Cost between 1000 and 2000 ringgit';
  assert.equal(stripDatePhrasing(numberRange1), 'Cost between 1000 and 2000 ringgit');

  const numberRange2 = 'Price from 5000 to 9000 per sqm';
  assert.equal(stripDatePhrasing(numberRange2), 'Price from 5000 to 9000 per sqm');

  // CJK Chinese date range stripping and query variant generation
  const cjkQueryWithYearRange = '马来西亚2026年至2030年政治格局和国家政治走向';
  assert.equal(stripDatePhrasing(cjkQueryWithYearRange), '马来西亚政治格局和国家政治走向');
  const cjkVariants = buildSearchQueryVariants(cjkQueryWithYearRange);
  assert.ok(cjkVariants.includes('马来西亚2026年至2030年政治格局和国家政治走向'));
  assert.ok(cjkVariants.includes('马来西亚政治格局和国家政治走向'));
  assert.ok(cjkVariants.some((v) => v.includes('马来西亚') && v.includes('政治格局')));
}

// 2. DuckDuckGo anchor parsing: canonical title link prioritized over secondary uddg anchors
{
  const ddgHtmlWithMultipleUddg = `
    <table>
      <tr>
        <td>
          <a class='result-link' href='//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fanalysis&rut=1'>
            <b>Analysis</b> of Malaysia Political Landscape
          </a>
        </td>
      </tr>
      <tr>
        <td class='result-snippet'>
          Comprehensive analysis of coalition shifts, parliamentary alignments, and electoral developments in Malaysia.
        </td>
      </tr>
      <tr>
        <td>
          <a class='result-url' href='//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fanalysis'>example.com/analysis</a>
        </td>
      </tr>
    </table>
  `;

  const results = extractSearchResultsFromDuckDuckGoHtml(ddgHtmlWithMultipleUddg);
  assert.equal(results.length, 1);
  assert.equal(results[0].title, 'Analysis of Malaysia Political Landscape');
  assert.equal(results[0].url, 'https://example.com/analysis');
  assert.equal(results[0].domain, 'example.com');
  assert.ok(results[0].snippet.includes('Comprehensive analysis of coalition shifts'));

  // If a title anchor's snippet is too short (<30 chars), secondary URL anchor should NOT become a result
  const ddgHtmlWithShortSnippet = `
    <table>
      <tr>
        <td>
          <a class='result-link' href='//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fshort&rut=1'>
            Short Snippet Title
          </a>
        </td>
      </tr>
      <tr>
        <td class='result-snippet'>
          Too short.
        </td>
      </tr>
      <tr>
        <td>
          <a class='result-url' href='//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fshort'>example.com/short</a>
        </td>
      </tr>
    </table>
  `;
  const emptyResults = extractSearchResultsFromDuckDuckGoHtml(ddgHtmlWithShortSnippet);
  assert.equal(emptyResults.length, 0);

  // data-href should not be mistaken for href
  const ddgHtmlDataHref = `
    <a class='result-link' data-href='//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdata'>No Href Link</a>
  `;
  assert.equal(extractSearchResultsFromDuckDuckGoHtml(ddgHtmlDataHref).length, 0);

  // A secondary URL anchor followed by a long snippet is rejected because it is a display URL/domain
  const ddgHtmlUrlAnchorFollowedByLongSnippet = `
    <table>
      <tr>
        <td>
          <a class='result-url' href='//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Ftarget'>example.com/target</a>
        </td>
      </tr>
      <tr>
        <td class='result-snippet'>
          This is a sufficiently long snippet that would pass length checks if the anchor was mistakenly treated as a title.
        </td>
      </tr>
    </table>
  `;
  assert.equal(extractSearchResultsFromDuckDuckGoHtml(ddgHtmlUrlAnchorFollowedByLongSnippet).length, 0);
}

// 3. DuckDuckGo snippet extraction: result__snippet takes precedence over result__extras display URL
{
  const html = `
    <div class="result__body">
      <h2 class="result__title">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">Title A</a>
      </h2>
      <div class="result__extras">
        <div class="result__extras__url">
          <a class="result__url" href="//duckduckgo.com/l/?uddg=x">themalaysiantimes.com.my/how-malaysias-political-landscape-will-evolve-in-2026/</a>
        </div>
      </div>
      <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">Malaysia's unity government enters 2026 with a stronger majority.</a>
    </div>
  `;
  const [r] = extractSearchResultsFromDuckDuckGoHtml(html);
  assert.ok(r);
  assert.equal(r.title, 'Title A');
  assert.match(r.snippet, /^Malaysia's unity government/);
  assert.doesNotMatch(r.snippet, /themalaysiantimes/);
}

// 4. Non-Latin script preservation and CJK variant checks
{
  assert.notEqual(normalizeComparableText('马来西亚'), '');
  assert.notEqual(normalizeComparableText('москва'), '');
  assert.notEqual(normalizeComparableText('กรุงเทพ'), '');

  const cjkVariants = buildSearchQueryVariants('马来西亚政治格局在2026年');
  assert.ok(cjkVariants.includes('马来西亚政治格局'));
  assert.ok(cjkVariants.length >= 2);
}

console.log('googleSearchFallback request payload regression checks passed');
