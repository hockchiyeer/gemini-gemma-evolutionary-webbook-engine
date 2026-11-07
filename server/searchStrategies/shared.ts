import type { SearchFallbackResult } from '../../src/types.ts';
import {
  calculateTextSimilarity,
  isCjkMajority,
  normalizeComparableText,
  splitIntoSentences as sharedSplitIntoSentences,
} from '../../src/services/searchFallbackShared.ts';
import type { SearchFetchResult } from './types.ts';

export const MAX_RESULTS = 48;
export const MAX_RESULTS_PER_DOCUMENT = 12;
export const FETCH_TIMEOUT_MS = 7500;

export const DEFAULT_HEADERS = {
  'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'cache-control': 'no-cache',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
};

export const NAVIGATION_NOISE = [
  'sign in',
  'all',
  'news',
  'images',
  'videos',
  'shopping',
  'maps',
  'books',
  'flights',
  'finance',
  'tools',
  'more',
  'next',
  'previous',
  'cached',
  'translate this page',
  'settings',
  'privacy',
  'terms',
  'advertising',
  'business',
  'about',
  'how search works',
  'search help',
  'send feedback',
  'verbatim',
  'past hour',
  'past 24 hours',
  'past week',
  'past month',
  'past year',
];

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (entity, value: string) => {
    if (value[0] === '#') {
      const numericValue = value[1]?.toLowerCase() === 'x'
        ? Number.parseInt(value.slice(2), 16)
        : Number.parseInt(value.slice(1), 10);

      if (Number.isFinite(numericValue)) {
        return String.fromCodePoint(numericValue);
      }

      return entity;
    }

    switch (value) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
      case '#39':
        return "'";
      case 'nbsp':
        return ' ';
      default:
        return entity;
    }
  });
}

export function collapseWhitespace(input: string): string {
  return input.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

export { normalizeComparableText };

export function stripHtmlToText(input: string): string {
  return collapseWhitespace(
    decodeHtmlEntities(
      input
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|section|article|table|tr|td|h\d)>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
    )
  );
}

export function stripHtmlToLines(input: string): string[] {
  const normalized = decodeHtmlEntities(
    input
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|section|article|table|tr|td|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  );

  return normalized
    .split(/\n+/)
    .map((line) => collapseWhitespace(line))
    .filter(Boolean);
}

export function normalizeGoogleSearchHref(rawHref: string): string | null {
  try {
    const decodedHref = decodeHtmlEntities(rawHref);

    if (decodedHref.startsWith('http://') || decodedHref.startsWith('https://')) {
      return decodedHref;
    }

    const url = new URL(decodedHref, 'https://www.google.com');
    if (url.hostname !== 'www.google.com' && url.hostname !== 'google.com') {
      return url.toString();
    }

    if (url.pathname === '/url') {
      return url.searchParams.get('q') || url.searchParams.get('url');
    }

    return null;
  } catch {
    return null;
  }
}

export function normalizeDuckDuckGoHref(rawHref: string): string | null {
  try {
    const decodedHref = decodeHtmlEntities(rawHref);
    const url = new URL(decodedHref, 'https://duckduckgo.com');

    if (url.hostname.endsWith('duckduckgo.com') && url.pathname === '/l/') {
      const target = url.searchParams.get('uddg');
      if (!target) return null;

      try {
        return decodeURIComponent(target);
      } catch {
        return target;
      }
    }

    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return url.toString();
    }

    return null;
  } catch {
    return null;
  }
}

export function isExternalResultUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    const hostname = url.hostname.replace(/^www\./, '');
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      hostname !== 'google.com' &&
      !hostname.endsWith('.google.com') &&
      hostname !== 'youtube.com' &&
      !hostname.endsWith('.youtube.com') &&
      hostname !== 'duckduckgo.com'
    );
  } catch {
    return false;
  }
}

export function isLikelyResultTitle(title: string): boolean {
  const normalized = title.toLowerCase().trim();
  if (normalized.length < 2 || normalized.length > 300) return false;
  if (NAVIGATION_NOISE.some((noise) => normalized === noise || normalized.startsWith(`${noise} `) || normalized.endsWith(` ${noise}`))) {
    return false;
  }
  // Reject titles that are bare URLs or display domains (requiring http/www, a path slash, or a common web domain)
  if (
    /^(?:https?:\/\/|www\.)\S+$/i.test(normalized) ||
    /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)+\/[^\s]*$/i.test(normalized) ||
    /^[a-z0-9_-]+\.(?:com|org|net|gov|edu|io|my|sg|info|biz|me)$/i.test(normalized)
  ) {
    return false;
  }
  return /[a-z0-9]/i.test(normalized);
}

export function extractSnippetFromContext(contextHtml: string, title: string): string {
  const snippetPatterns = [
    /<div[^>]*class=["\x27][^"\x27]*VwiC3b[^"\x27]*["\x27][^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*class=["\x27][^"\x27]*BNeawe[^"\x27]*s3v9rd[^"\x27]*["\x27][^>]*>([\s\S]*?)<\/div>/i,
    /<span[^>]*class=["\x27][^"\x27]*aCOpRe[^"\x27]*["\x27][^>]*>([\s\S]*?)<\/span>/i,
    /<div[^>]*data-s[nc]{2}f=["\x27][^"\x27]*["\x27][^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*class=["\x27][^"\x27]*MUFwZ[^"\x27]*["\x27][^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*class=["\x27][^"\x27]*yD979[^"\x27]*["\x27][^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*class=["\x27][^"\x27]*K8v00d[^"\x27]*["\x27][^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*class=["\x27][^"\x27]*lEBKkf[^"\x27]*["\x27][^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*class=["\x27][^"\x27]*kb0Odf[^"\x27]*["\x27][^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*class=["\x27][^"\x27]*L5V62d[^"\x27]*["\x27][^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*class=["\x27][^"\x27]*wDY59b[^"\x27]*["\x27][^>]*>([\s\S]*?)<\/div>/i,
    /<a[^>]*class=["\x27][^"\x27]*result__snippet[^"\x27]*["\x27][^>]*>([\s\S]*?)<\/a>/i,
    /<div[^>]*class=["\x27][^"\x27]*result__snippet[^"\x27]*["\x27][^>]*>([\s\S]*?)<\/div>/i,
    /<td[^>]*class=["\x27][^"\x27]*result-snippet[^"\x27]*["\x27][^>]*>([\s\S]*?)<\/td>/i,
    /<div[^>]*class=["\x27][^"\x27]*snippet[^"\x27]*["\x27][^>]*>([\s\S]*?)<\/div>/i,
    // Catch-alls last: any class containing "s" also matches DuckDuckGo's result__extras block, whose text is the display URL.
    /<div[^>]*class=["\x27][^"\x27]*st[^"\x27]*["\x27][^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*class=["\x27][^"\x27]*s[^"\x27]*["\x27][^>]*>([\s\S]*?)<\/div>/i,
    /<span[^>]*class=["\x27][^"\x27]*st[^"\x27]*["\x27][^>]*>([\s\S]*?)<\/span>/i,
  ];

  for (const pattern of snippetPatterns) {
    const match = contextHtml.match(pattern);
    if (!match?.[1]) continue;

    const snippet = stripHtmlToText(match[1]);
    if (snippet.length >= 30) {
      return snippet.slice(0, 480);
    }
  }

  // Fallback: just take the next few meaningful sentences if no specific container matches.
  const plainText = stripHtmlToText(contextHtml)
    .replace(new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), '')
    .trim();

  if (plainText.length >= 30) {
    return plainText.slice(0, 480);
  }

  return '';
}

export function splitIntoSentences(text: string): string[] {
  return sharedSplitIntoSentences(text)
    .map((sentence) => collapseWhitespace(sentence))
    .filter((sentence) => (isCjkMajority(sentence) ? sentence.length >= 8 : sentence.length >= 35));
}

export function dedupeSentences(text: string, maxSentences = Number.POSITIVE_INFINITY): string[] {
  const unique: string[] = [];

  for (const sentence of splitIntoSentences(text)) {
    if (unique.some((existing) => calculateTextSimilarity(existing, sentence) >= 0.88)) {
      continue;
    }

    unique.push(sentence);
    if (unique.length >= maxSentences) {
      break;
    }
  }

  return unique;
}

export function sanitizeFallbackSnippet(text: string): string {
  const cleaned = collapseWhitespace(text.replace(/\.\.\.\s*(?=[A-Z])/g, ' '));
  const uniqueSentences = dedupeSentences(cleaned, 4);
  return uniqueSentences.length > 0 ? uniqueSentences.join(' ') : cleaned;
}

export function selectDistinctSearchResults(results: ReadonlyArray<SearchFallbackResult>, maxResults = MAX_RESULTS): SearchFallbackResult[] {
  const distinct: SearchFallbackResult[] = [];

  for (const result of results) {
    const candidate: SearchFallbackResult = {
      ...result,
      title: collapseWhitespace(result.title),
      snippet: sanitizeFallbackSnippet(result.snippet),
    };

    if (!candidate.title || !candidate.snippet) {
      continue;
    }

    const isDuplicate = distinct.some((existing) => {
      if (existing.url === candidate.url) {
        return true;
      }

      const titleSimilarity = calculateTextSimilarity(existing.title, candidate.title);
      const snippetSimilarity = calculateTextSimilarity(existing.snippet, candidate.snippet);
      return titleSimilarity >= 0.78 || (titleSimilarity >= 0.58 && snippetSimilarity >= 0.72) || snippetSimilarity >= 0.9;
    });

    if (isDuplicate) {
      continue;
    }

    distinct.push(candidate);
    if (distinct.length >= maxResults) {
      break;
    }
  }

  return distinct;
}

export function interleaveSearchResults(primary: ReadonlyArray<SearchFallbackResult>, secondary: ReadonlyArray<SearchFallbackResult>): SearchFallbackResult[] {
  const interleaved: SearchFallbackResult[] = [];
  const maxLength = Math.max(primary.length, secondary.length);

  for (let index = 0; index < maxLength; index += 1) {
    if (primary[index]) {
      interleaved.push(primary[index]);
    }
    if (secondary[index]) {
      interleaved.push(secondary[index]);
    }
  }

  return interleaved;
}

export function buildDiagnostics(fetches: ReadonlyArray<SearchFetchResult>, resultsCount: number, provider: 'google' | 'duckduckgo', isGoogleBlockedPage?: (html: string) => boolean, isGoogleNoResultsPage?: (html: string) => boolean): string[] {
  const diagnostics = fetches.map((attempt) => {
    const blockedNote = provider === 'google' && isGoogleBlockedPage?.(attempt.html) ? ' blocked-by-google' : '';
    const noResultsNote = provider === 'google' && isGoogleNoResultsPage?.(attempt.html) ? ' no-results' : '';
    return `${attempt.label}:${attempt.status}${blockedNote}${noResultsNote}`;
  });

  diagnostics.push(`${provider}-results:${resultsCount}`);
  return diagnostics;
}

export async function fetchSearchHtml(
  url: URL | string,
  label: string,
  headers: Record<string, string> = DEFAULT_HEADERS,
  init: RequestInit = {}
): Promise<SearchFetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...init,
      headers,
      signal: controller.signal,
    });

    return {
      label,
      url: response.url,
      status: response.status,
      html: await response.text(),
    };
  } finally {
    clearTimeout(timer);
  }
}
