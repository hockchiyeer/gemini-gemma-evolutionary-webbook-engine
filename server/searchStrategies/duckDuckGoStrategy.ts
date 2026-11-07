import type { SearchFallbackResult } from '../../src/types.ts';
import { isCjkMajority } from '../../src/services/searchFallbackShared.ts';
import type { DuckDuckGoEvidence, SearchFetchResult } from './types.ts';
import {
  DEFAULT_HEADERS,
  MAX_RESULTS,
  MAX_RESULTS_PER_DOCUMENT,
  buildDiagnostics,
  collapseWhitespace,
  extractSnippetFromContext,
  fetchSearchHtml,
  isExternalResultUrl,
  isLikelyResultTitle,
  normalizeDuckDuckGoHref,
  selectDistinctSearchResults,
  stripHtmlToText,
} from './shared.ts';

const DUCKDUCKGO_SEARCH_URL = 'https://html.duckduckgo.com/html/';
const DUCKDUCKGO_LITE_URL = 'https://lite.duckduckgo.com/lite/';
const DUCKDUCKGO_INSTANT_ANSWER_URL = 'https://api.duckduckgo.com/';
const DUCKDUCKGO_LITE_ESCALATION_THRESHOLD = 4;

function parseDuckDuckGoAnchors(html: string, requireClassMatch: boolean): SearchFallbackResult[] {
  const seenUrls = new Set<string>();
  const results: SearchFallbackResult[] = [];

  // Match <a> tags with flexible quotes and arbitrary attribute order (e.g. DDG Lite where href precedes class and uses single quotes)
  const aTagPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = aTagPattern.exec(html)) !== null && results.length < MAX_RESULTS_PER_DOCUMENT) {
    const attrs = match[1];
    const hasClass = /class=["\x27][^"\x27]*(?:result__a|result-link)[^"\x27]*["\x27]/i.test(attrs);
    const hasUddg = /[\?&]uddg=/i.test(attrs);

    if (requireClassMatch ? !hasClass : (!hasClass && !hasUddg)) {
      continue;
    }

    // In fallback pass, explicitly ignore anchors known to be display URLs, snippets, or extras
    if (!requireClassMatch && /class=["\x27][^"\x27]*(?:result[-_]+(?:url|extras|snippet)|badge)[^"\x27]*["\x27]/i.test(attrs)) {
      continue;
    }

    const hrefMatch = attrs.match(/\shref=["\x27]([^"\x27]+)["\x27]/i);
    if (!hrefMatch?.[1]) continue;

    const url = normalizeDuckDuckGoHref(hrefMatch[1]);
    if (!url || !isExternalResultUrl(url) || seenUrls.has(url)) {
      continue;
    }

    const title = stripHtmlToText(match[2]);
    if (!isLikelyResultTitle(title)) {
      continue;
    }

    const contextHtml = html.slice(match.index, match.index + 2800);
    const snippet = extractSnippetFromContext(contextHtml, title);
    if (snippet.length < 30) {
      continue;
    }

    try {
      const parsedUrl = new URL(url);
      results.push({
        title,
        url,
        domain: parsedUrl.hostname.replace(/^www\./, ''),
        snippet,
      });
      seenUrls.add(url);
    } catch {
      // Ignore malformed URLs.
    }
  }

  return results;
}

export function extractSearchResultsFromDuckDuckGoHtml(html: string): SearchFallbackResult[] {
  // First, prioritize canonical title links (result__a or result-link)
  const primaryResults = parseDuckDuckGoAnchors(html, true);
  if (primaryResults.length > 0) {
    return primaryResults;
  }
  // Fallback if class names changed: allow any anchor carrying uddg parameter
  return parseDuckDuckGoAnchors(html, false);
}

export function collectInstantAnswerTopics(topics: any[]): Array<{ text: string; firstUrl: string }> {
  const collected: Array<{ text: string; firstUrl: string }> = [];

  for (const topic of topics || []) {
    if (!topic || typeof topic !== 'object') {
      continue;
    }

    if (Array.isArray(topic.Topics)) {
      collected.push(...collectInstantAnswerTopics(topic.Topics));
      continue;
    }

    const text = collapseWhitespace(String(topic.Text || ''));
    const firstUrl = String(topic.FirstURL || '');
    if (!text || !firstUrl) {
      continue;
    }

    collected.push({ text, firstUrl });
  }

  return collected;
}

export function extractSearchResultsFromDuckDuckGoInstantAnswer(payload: any): SearchFallbackResult[] {
  const candidates: SearchFallbackResult[] = [];
  const pushCandidate = (title: string, url: string, snippet: string) => {
    if (!title || !url || !snippet || !isExternalResultUrl(url)) {
      return;
    }

    try {
      const parsed = new URL(url);
      candidates.push({
        title: collapseWhitespace(title).slice(0, 180),
        url: parsed.toString(),
        domain: parsed.hostname.replace(/^www\./, ''),
        snippet: collapseWhitespace(snippet).slice(0, 420),
      });
    } catch {
      // Ignore malformed URLs.
    }
  };

  const abstractText = collapseWhitespace(String(payload?.AbstractText || ''));
  const abstractUrl = String(payload?.AbstractURL || '');
  const heading = collapseWhitespace(String(payload?.Heading || ''));
  if (abstractText.length >= 40 && abstractUrl) {
    pushCandidate(heading || 'DuckDuckGo Instant Answer', abstractUrl, abstractText);
  }

  const definition = collapseWhitespace(String(payload?.Definition || ''));
  const definitionUrl = String(payload?.DefinitionURL || '');
  const entity = collapseWhitespace(String(payload?.Entity || ''));
  if (definition.length >= 40 && definitionUrl) {
    pushCandidate(entity || heading || 'DuckDuckGo Definition', definitionUrl, definition);
  }

  const relatedTopics = collectInstantAnswerTopics(payload?.RelatedTopics || []);
  relatedTopics.slice(0, MAX_RESULTS_PER_DOCUMENT).forEach((topic) => {
    if (topic.text.length < 40) return;

    const title = topic.text.split(/[-|:]/)[0]?.trim() || heading || 'DuckDuckGo Topic';
    pushCandidate(title, topic.firstUrl, topic.text);
  });

  return selectDistinctSearchResults(candidates, MAX_RESULTS_PER_DOCUMENT);
}

export async function fetchDuckDuckGoAttempt(query: string, labelSuffix: string): Promise<SearchFetchResult | null> {
  const searchUrl = new URL(DUCKDUCKGO_SEARCH_URL);
  searchUrl.searchParams.set('q', query);
  if (!isCjkMajority(query)) {
    searchUrl.searchParams.set('kl', 'us-en');
  }

  try {
    return await fetchSearchHtml(searchUrl, `duckduckgo-html-${labelSuffix}`);
  } catch {
    return null;
  }
}

export async function fetchDuckDuckGoLiteAttempt(query: string, labelSuffix: string): Promise<SearchFetchResult | null> {
  const searchUrl = new URL(DUCKDUCKGO_LITE_URL);
  searchUrl.searchParams.set('q', query);
  if (!isCjkMajority(query)) {
    searchUrl.searchParams.set('kl', 'us-en');
  }

  try {
    const getResult = await fetchSearchHtml(searchUrl, `duckduckgo-lite-get-${labelSuffix}`);
    if (getResult.status === 200) {
      return getResult;
    }
  } catch {
    // Continue to POST attempt
  }

  const postParams = new URLSearchParams({ q: query });
  if (!isCjkMajority(query)) {
    postParams.set('kl', 'us-en');
  }

  try {
    return await fetchSearchHtml(
      DUCKDUCKGO_LITE_URL,
      `duckduckgo-lite-post-${labelSuffix}`,
      {
        ...DEFAULT_HEADERS,
        'content-type': 'application/x-www-form-urlencoded',
      },
      {
        method: 'POST',
        body: postParams.toString(),
      }
    );
  } catch {
    return null;
  }
}

export async function fetchDuckDuckGoInstantAnswer(query: string): Promise<{ status: number; results: SearchFallbackResult[] } | null> {
  const endpoint = new URL(DUCKDUCKGO_INSTANT_ANSWER_URL);
  endpoint.searchParams.set('q', query);
  endpoint.searchParams.set('format', 'json');
  endpoint.searchParams.set('no_html', '1');
  endpoint.searchParams.set('skip_disambig', '1');

  try {
    const response = await fetch(endpoint, {
      headers: {
        accept: 'application/json',
        'accept-language': 'en-US,en;q=0.9',
        'cache-control': 'no-cache',
        'user-agent': DEFAULT_HEADERS['user-agent'],
      },
    });

    const payload = await response.json();
    return {
      status: response.status,
      results: extractSearchResultsFromDuckDuckGoInstantAnswer(payload),
    };
  } catch {
    return null;
  }
}

export async function collectDuckDuckGoEvidence(queryVariants: string[]): Promise<DuckDuckGoEvidence> {
  const htmlAttemptResults = await Promise.all(
    queryVariants.map((variant, index) => fetchDuckDuckGoAttempt(variant, `q${index + 1}`))
  );
  const attempts = htmlAttemptResults.filter((a): a is SearchFetchResult => Boolean(a));
  const htmlResults = selectDistinctSearchResults(
    attempts.flatMap((a) => extractSearchResultsFromDuckDuckGoHtml(a.html)),
    MAX_RESULTS
  );

  let liteAttempts: SearchFetchResult[] = [];
  let liteResults: SearchFallbackResult[] = [];
  if (htmlResults.length < DUCKDUCKGO_LITE_ESCALATION_THRESHOLD) {
    const liteAttemptResults = await Promise.all(
      queryVariants.map((variant, index) => fetchDuckDuckGoLiteAttempt(variant, `q${index + 1}`))
    );
    liteAttempts = liteAttemptResults.filter((a): a is SearchFetchResult => Boolean(a));
    liteResults = selectDistinctSearchResults(
      liteAttempts.flatMap((a) => extractSearchResultsFromDuckDuckGoHtml(a.html)),
      MAX_RESULTS
    );
  }

  let mergedResults = selectDistinctSearchResults([...htmlResults, ...liteResults], MAX_RESULTS);

  let instantAnswer: DuckDuckGoEvidence['instantAnswer'] = null;
  if (mergedResults.length === 0) {
    instantAnswer = await fetchDuckDuckGoInstantAnswer(queryVariants[0] || '');
    if (instantAnswer && instantAnswer.results.length > 0) {
      mergedResults = selectDistinctSearchResults(
        [...mergedResults, ...instantAnswer.results],
        MAX_RESULTS
      );
    }
  }

  const diagnostics: string[] = [];
  if (attempts.length > 0) {
    diagnostics.push(...buildDiagnostics(attempts, htmlResults.length, 'duckduckgo'));
  } else {
    diagnostics.push('duckduckgo-html:fetch-failed');
  }
  if (liteAttempts.length > 0) {
    diagnostics.push(...liteAttempts.map((a) => `duckduckgo-lite-${a.label.split('-').pop()}:${a.status}`));
    diagnostics.push(`duckduckgo-lite-results:${liteResults.length}`);
  }
  if (instantAnswer) {
    diagnostics.push(`duckduckgo-instant:${instantAnswer.status}`);
    diagnostics.push(`duckduckgo-instant-results:${instantAnswer.results.length}`);
  }

  return { attempts, liteAttempts, instantAnswer, results: mergedResults, diagnostics };
}
