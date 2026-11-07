import type { SearchFallbackResult } from '../../src/types.ts';
import type { GoogleEvidence, SearchFetchResult } from './types.ts';
import {
  MAX_RESULTS,
  MAX_RESULTS_PER_DOCUMENT,
  buildDiagnostics,
  extractSnippetFromContext,
  fetchSearchHtml,
  isExternalResultUrl,
  isLikelyResultTitle,
  normalizeGoogleSearchHref,
  selectDistinctSearchResults,
  stripHtmlToLines,
  stripHtmlToText,
  wait,
} from './shared.ts';

const GOOGLE_SEARCH_URL = 'https://www.google.com/search';
const GOOGLE_QUERY_VARIANT_LIMIT = 2;
const GOOGLE_RESULT_TARGET = 8;
const GOOGLE_VARIANT_DELAY_MS = 350;

const AI_OVERVIEW_STOP_HEADINGS = [
  'people also ask',
  'top stories',
  'videos',
  'images',
  'discussions and forums',
  'related searches',
  'see results about',
  'knowledge panel',
  'sources',
];

export function isGoogleNoResultsPage(html: string): boolean {
  const normalized = stripHtmlToText(html).toLowerCase();
  return (
    normalized.includes('did not match any documents') ||
    normalized.includes('no results found for') ||
    normalized.includes('try different keywords') ||
    normalized.includes('check your spelling')
  );
}

export function isGoogleBlockedPage(html: string): boolean {
  const normalized = stripHtmlToText(html).toLowerCase();
  return (
    normalized.includes('unusual traffic from your computer network') ||
    normalized.includes('our systems have detected unusual traffic') ||
    normalized.includes('detected unusual traffic') ||
    normalized.includes('not a robot') ||
    normalized.includes('please click here if you are not redirected within a few seconds') ||
    normalized.includes('captcha') ||
    normalized.includes('recaptcha') ||
    normalized.includes('security check') ||
    normalized.includes('verify you are a human') ||
    normalized.includes('automated queries') ||
    normalized.includes('support.google.com/websearch/answer/86640')
  );
}

export function isBlockedGoogleAttempt(attempt: SearchFetchResult): boolean {
  return attempt.status === 429 || isGoogleBlockedPage(attempt.html);
}

export function extractAiOverview(html: string): string[] {
  const lines = stripHtmlToLines(html);
  const startIndex = lines.findIndex((line) => /ai overview/i.test(line));
  if (startIndex < 0) {
    return [];
  }

  const overview: string[] = [];
  for (const line of lines.slice(startIndex + 1, startIndex + 28)) {
    const normalized = line.toLowerCase();

    if (AI_OVERVIEW_STOP_HEADINGS.some((heading) => normalized.includes(heading))) {
      break;
    }

    if (line.length < 48 || line.length > 420) {
      continue;
    }

    if (overview.includes(line)) {
      continue;
    }

    overview.push(line);
    if (overview.join(' ').length >= 900) {
      break;
    }
  }

  return overview;
}

export function extractSearchResultsFromGoogleHtml(html: string): SearchFallbackResult[] {
  const anchorPattern = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const seenUrls = new Set<string>();
  const results: SearchFallbackResult[] = [];

  let match: RegExpExecArray | null;
  while ((match = anchorPattern.exec(html)) !== null && results.length < MAX_RESULTS_PER_DOCUMENT) {
    const url = normalizeGoogleSearchHref(match[1]);
    if (!url || !isExternalResultUrl(url) || seenUrls.has(url)) {
      continue;
    }

    const title = stripHtmlToText(match[2]);
    if (!isLikelyResultTitle(title)) {
      continue;
    }

    const contextStart = match.index + match[0].length;
    const contextHtml = html.slice(contextStart, contextStart + 3000);
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

export async function fetchGoogleAttempts(query: string, labelSuffix: string): Promise<SearchFetchResult[]> {
  const desktopUrl = new URL(GOOGLE_SEARCH_URL);
  desktopUrl.searchParams.set('q', query);
  desktopUrl.searchParams.set('hl', 'en');
  desktopUrl.searchParams.set('gl', 'us');
  desktopUrl.searchParams.set('num', '12');
  desktopUrl.searchParams.set('pws', '0');

  const basicUrl = new URL(desktopUrl.toString());
  basicUrl.searchParams.set('gbv', '1');

  const webOnlyUrl = new URL(desktopUrl.toString());
  webOnlyUrl.searchParams.set('udm', '14');

  const attempts: SearchFetchResult[] = [];
  const searchTargets: Array<{ url: URL; label: string }> = [
    { url: desktopUrl, label: `google-desktop-${labelSuffix}` },
    { url: basicUrl, label: `google-basic-${labelSuffix}` },
    { url: webOnlyUrl, label: `google-web-${labelSuffix}` },
  ];

  for (const [index, target] of searchTargets.entries()) {
    try {
      const attempt = await fetchSearchHtml(target.url, target.label);
      attempts.push(attempt);

      if (isBlockedGoogleAttempt(attempt)) {
        break;
      }
    } catch {
      // Ignore per-endpoint failures and continue to the next Google surface.
    }

    if (index < searchTargets.length - 1) {
      await wait(140);
    }
  }

  return attempts;
}

export async function collectGoogleSearchEvidence(queryVariants: string[]): Promise<GoogleEvidence> {
  const attempts: SearchFetchResult[] = [];
  let aiOverview: string[] = [];
  let results: SearchFallbackResult[] = [];
  const limitedVariants = queryVariants.slice(0, GOOGLE_QUERY_VARIANT_LIMIT);

  for (const [index, variant] of limitedVariants.entries()) {
    const variantAttempts = await fetchGoogleAttempts(variant, `q${index + 1}`);
    attempts.push(...variantAttempts);

    if (aiOverview.length === 0) {
      aiOverview = variantAttempts.flatMap((attempt) => extractAiOverview(attempt.html));
    }

    const variantResults = selectDistinctSearchResults(
      variantAttempts.flatMap((attempt) => extractSearchResultsFromGoogleHtml(attempt.html)),
      MAX_RESULTS
    );
    results = selectDistinctSearchResults([...results, ...variantResults], MAX_RESULTS);

    const variantFullyBlocked = variantAttempts.length > 0 && variantAttempts.every(isBlockedGoogleAttempt);
    if (aiOverview.length > 0 || results.length >= GOOGLE_RESULT_TARGET || variantFullyBlocked) {
      break;
    }

    if (index < limitedVariants.length - 1) {
      await wait(GOOGLE_VARIANT_DELAY_MS);
    }
  }

  const allBlocked = attempts.length > 0 && attempts.every(isBlockedGoogleAttempt);
  const diagnostics = buildDiagnostics(attempts, results.length, 'google', isGoogleBlockedPage, isGoogleNoResultsPage);

  return {
    attempts,
    aiOverview,
    results,
    didBlock: allBlocked,
    noResults: attempts.length > 0 && attempts.every((a) => isGoogleNoResultsPage(a.html)),
    diagnostics,
  };
}
