import type {
  SearchArtifact,
  SearchFallbackMode,
  SearchFallbackPayload,
  SearchFallbackProvider,
} from '../types';

const GOOGLE_SEARCH_URL = 'https://www.google.com/search';
const DUCKDUCKGO_PUBLIC_SEARCH_URL = 'https://duckduckgo.com/';
// Marks a placeholder payload that was fabricated because no live search evidence was found.
export const SYNTHETIC_FALLBACK_DIAGNOSTIC = 'Synthetic fallback payload generated due to limited search evidence.';
export const FALLBACK_STOPWORDS = new Set([
  'about',
  'after',
  'also',
  'amid',
  'among',
  'and',
  'around',
  'been',
  'between',
  'from',
  'into',
  'over',
  'that',
  'their',
  'them',
  'they',
  'this',
  'through',
  'under',
  'with',
]);

/** Canonical CJK character range covering Chinese, Japanese, Korean, and compatibility ideographs. */
export const CJK_CHAR_PATTERN = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff]/;
export const CJK_CHAR_GLOBAL_PATTERN = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff]/g;

export function hasCjk(text: string): boolean {
  return CJK_CHAR_PATTERN.test(text);
}

export function countWords(text: string): number {
  const cjkCount = (text.match(CJK_CHAR_GLOBAL_PATTERN) || []).length;
  const nonCjk = text.replace(CJK_CHAR_GLOBAL_PATTERN, ' ').trim();
  const nonCjkWords = nonCjk ? nonCjk.split(/\s+/).filter(Boolean).length : 0;
  return cjkCount + nonCjkWords;
}

export function isCjkMajority(text: string): boolean {
  const cjkCount = (text.match(CJK_CHAR_GLOBAL_PATTERN) || []).length;
  const nonWsLength = text.replace(/\s+/g, '').length;
  return nonWsLength > 0 && cjkCount / nonWsLength >= 0.4;
}

export function splitIntoSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|(?<=[。！？][”’」』）)]*)(?![”’」』）)])\s*/)
    .map((sentence) => sentence.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

export function normalizeComparableText(input: string): string {
  return input
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/([a-z0-9]+)([\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff])/gi, '$1 $2')
    .replace(/([\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff])([a-z0-9]+)/gi, '$1 $2')
    .replace(/[^\w\s\u0080-\u024f\u0370-\u03ff\u0400-\u04ff\u0600-\u06ff\u0900-\u097f\u0e00-\u0e7f\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeComparableText(input: string): string[] {
  const norm = normalizeComparableText(input);
  const words = norm
    .split(' ')
    .filter((token) => token.length >= 3 && !FALLBACK_STOPWORDS.has(token));

  const cjkChars = norm.match(CJK_CHAR_GLOBAL_PATTERN);
  if (cjkChars && cjkChars.length > 0) {
    for (let i = 0; i < cjkChars.length - 1; i++) {
      words.push(cjkChars[i] + cjkChars[i + 1]);
    }
    if (cjkChars.length === 1) {
      words.push(cjkChars[0]);
    }
  }

  return words;
}

export function calculateTextSimilarity(left: string, right: string): number {
  const normalizedLeft = normalizeComparableText(left);
  const normalizedRight = normalizeComparableText(right);

  if (!normalizedLeft || !normalizedRight) {
    return 0;
  }

  if (normalizedLeft === normalizedRight) {
    return 1;
  }

  const shorter = normalizedLeft.length <= normalizedRight.length ? normalizedLeft : normalizedRight;
  const longer = shorter === normalizedLeft ? normalizedRight : normalizedLeft;
  if (shorter.length >= 32 && longer.includes(shorter)) {
    return 0.96;
  }

  const leftTokens = new Set(tokenizeComparableText(left));
  const rightTokens = new Set(tokenizeComparableText(right));
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }

  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      overlap += 1;
    }
  }

  return overlap / new Set([...leftTokens, ...rightTokens]).size;
}

export function getFallbackResultCount(
  payload: SearchFallbackPayload,
  provider: SearchFallbackProvider
): number {
  // DuckDuckGo evidence can come from its HTML, Lite or Instant Answer endpoints, each reported separately.
  const prefixes = provider === 'duckduckgo'
    ? ['duckduckgo-results:', 'duckduckgo-lite-results:', 'duckduckgo-instant-results:']
    : [`${provider}-results:`];
  const counts = (payload.diagnostics || []).flatMap((entry) => (
    prefixes
      .filter((prefix) => entry.startsWith(prefix))
      .map((prefix) => Number.parseInt(entry.slice(prefix.length), 10))
  )).filter((count) => Number.isFinite(count));

  if (counts.length === 0) {
    return payload.provider === provider ? payload.results.length : 0;
  }

  return counts.reduce((total, count) => total + count, 0);
}

export function hasDuckDuckGoFallbackEvidence(payload: SearchFallbackPayload): boolean {
  return getFallbackResultCount(payload, 'duckduckgo') > 0;
}

export function hasGoogleFallbackEvidence(payload: SearchFallbackPayload): boolean {
  return payload.source === 'google-ai-overview' || getFallbackResultCount(payload, 'google') > 0;
}

export function isSyntheticFallbackPayload(payload?: SearchFallbackPayload): boolean {
  return Boolean(payload?.diagnostics?.includes(SYNTHETIC_FALLBACK_DIAGNOSTIC));
}

/** Reports which fallback providers actually contributed evidence, for user-facing notices and metadata. */
export function describeFallbackEvidence(
  payload: SearchFallbackPayload,
  mode: SearchFallbackMode
): { label: string; source: 'google' | 'duckduckgo' | 'google_duckduckgo' } {
  let google = hasGoogleFallbackEvidence(payload);
  let duckduckgo = hasDuckDuckGoFallbackEvidence(payload);

  if (!google && !duckduckgo) {
    // Payloads without per-provider diagnostics: fall back to the declared provider.
    google = payload.provider !== 'duckduckgo';
    duckduckgo = payload.provider === 'duckduckgo' || payload.provider === 'google_duckduckgo';
  }

  if (google && duckduckgo) {
    return { label: 'Google fallback + DuckDuckGo fallback', source: 'google_duckduckgo' };
  }

  if (google) {
    return {
      label: mode === 'google_duckduckgo' ? 'Google fallback (DuckDuckGo contributed no results)' : 'Google fallback',
      source: 'google',
    };
  }

  return {
    label: mode === 'google_duckduckgo' ? 'DuckDuckGo fallback (Google contributed no results)' : 'DuckDuckGo fallback',
    source: 'duckduckgo',
  };
}

export function buildFallbackOverviewTitle(payload: SearchFallbackPayload): string {
  if (payload.source === 'google-ai-overview') {
    return hasDuckDuckGoFallbackEvidence(payload)
      ? `${payload.query} - Google AI Overview + DuckDuckGo Cross-Check`
      : `${payload.query} - Google AI Overview`;
  }

  if (hasGoogleFallbackEvidence(payload) && hasDuckDuckGoFallbackEvidence(payload)) {
    return `${payload.query} - Google + DuckDuckGo Search Summary`;
  }

  return payload.provider === 'duckduckgo'
    ? `${payload.query} - DuckDuckGo Search Summary`
    : `${payload.query} - Google Search Summary`;
}

export function buildFallbackSearchUrl(
  query: string,
  provider: SearchFallbackProvider = 'google'
): string {
  const searchUrl = new URL(provider === 'duckduckgo' ? DUCKDUCKGO_PUBLIC_SEARCH_URL : GOOGLE_SEARCH_URL);
  searchUrl.searchParams.set('q', query);

  if (provider === 'duckduckgo') {
    searchUrl.searchParams.set('ia', 'web');
  }

  return searchUrl.toString();
}

export function isValidConceptDefinition(term: string, description: string): boolean {
  if (!term || !description) return false;
  const cleanTerm = term.trim();
  const cleanDesc = description.trim();

  if (cleanTerm.length < 2 || cleanTerm.length > 50 || cleanDesc.length < 20) return false;

  // Reject all-caps news datelines like "KUALA LUMPUR", "WASHINGTON", "NEW YORK"
  if (/^[A-Z\s,]{2,30}$/.test(cleanTerm) && (cleanTerm.includes(',') || cleanTerm.split(/\s+/).length >= 2 || cleanTerm.length >= 8)) {
    return false;
  }

  // Reject status prefixes like "UPDATE", "BREAKING", "LIVE", "PHOTO"
  if (/^(?:UPDATE|BREAKING|LIVE|PHOTO|VIDEO|WATCH|READ|LISTEN)\b/i.test(cleanTerm)) {
    return false;
  }

  // Reject unbalanced parentheses or brackets in term
  const termOpenParen = (cleanTerm.match(/\(/g) || []).length;
  const termCloseParen = (cleanTerm.match(/\)/g) || []).length;
  if (termOpenParen !== termCloseParen) return false;

  const termOpenBracket = (cleanTerm.match(/\[/g) || []).length;
  const termCloseBracket = (cleanTerm.match(/\]/g) || []).length;
  if (termOpenBracket !== termCloseBracket) return false;

  // Reject terms ending in open bracket/language qualifier like "(English" or "in"
  if (/\((?:English|French|Spanish|Chinese|Malay|German)$/i.test(cleanTerm)) return false;

  // Reject descriptions starting with closing punctuation or brackets
  if (/^[)\]}]/.test(cleanDesc)) return false;

  return true;
}

export function deriveConceptLabel(title: string, fallbackQuery: string): string {
  const firstSegment = title.split(/[-:|—–]/)[0]?.trim();
  if (firstSegment && isValidConceptDefinition(firstSegment, 'A foundational concept regarding ' + fallbackQuery)) {
    return firstSegment;
  }

  return fallbackQuery;
}

export type SourceReliabilityTier = 'high' | 'medium' | 'low';

// Sites whose pages are user-generated, login-walled, social or storefront content: fine as a lead to follow, not as evidence.
// Matched on the registered name, so regional variants (shopee.com.my, amazon.co.uk, m.facebook.com) are covered too.
const LOW_RELIABILITY_NAMES = new Set([
  'facebook', 'fb', 'instagram', 'twitter', 'linkedin', 'tiktok', 'youtube', 'youtu', 'pinterest', 'reddit', 'quora', 'threads',
  'weibo', 'zhihu', 'xiaohongshu', 'scribd', 'slideshare', 'amazon', 'shopee', 'lazada', 'aliexpress', 'taobao',
]);
const LOW_RELIABILITY_HOSTS = ['x.com', 'tieba.baidu.com', 'answers.yahoo.com'];

const hostMatches = (hostname: string, domain: string): boolean => hostname === domain || hostname.endsWith(`.${domain}`);

/** The registered name of a host: "shopee" for www.shopee.com.my, "bbc" for news.bbc.co.uk. */
function registeredName(hostname: string): string {
  const labels = hostname.split('.');
  const n = labels.length;
  const secondLevel = n >= 3 && labels[n - 1].length === 2 && /^(?:com|co|org|net|gov|edu|ac)$/.test(labels[n - 2]);
  return labels[secondLevel ? n - 3 : n - 2] || '';
}

export function classifySourceReliability(url: string): SourceReliabilityTier {
  try {
    const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    if (LOW_RELIABILITY_NAMES.has(registeredName(hostname)) || LOW_RELIABILITY_HOSTS.some((domain) => hostMatches(hostname, domain))) return 'low';
    if (/(^|\.)(gov|edu|mil)(\.[a-z]{2})?$/.test(hostname) || /\.(ac|edu|gov)\.[a-z]{2}$/.test(hostname)) return 'high';
    if (hostMatches(hostname, 'wikipedia.org') || hostMatches(hostname, 'britannica.com')) return 'high';
    if (['reuters.com', 'apnews.com', 'bbc.com', 'bbc.co.uk', 'thestar.com.my', 'nst.com.my', 'straitstimes.com'].some((domain) => hostMatches(hostname, domain))) return 'high';
    if (hostname.endsWith('.org') || hostname.endsWith('.org.my')) return 'medium';
    return 'medium';
  } catch {
    return 'low';
  }
}

export function scoreDomainAuthority(url: string): number {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    const tier = classifySourceReliability(url);
    if (tier === 'low') return 0.4;
    if (hostname.endsWith('.gov')) return 0.96;
    if (hostname.endsWith('.edu')) return 0.92;
    if (hostname.includes('wikipedia.org')) return 0.88;
    if (hostname.endsWith('.org')) return 0.82;
    if (tier === 'high') return 0.86;
    return 0.72;
  } catch {
    return 0.65;
  }
}

export function scoreInformativeText(text: string): number {
  const wordCount = countWords(text);
  const sentenceCount = text.split(/[.!?。！？]+/).filter((segment) => segment.trim().length > 0).length;
  return Math.min(0.98, 0.35 + Math.min(wordCount / 180, 0.38) + Math.min(sentenceCount / 10, 0.25));
}

export function mapFallbackArtifacts(payload: SearchFallbackPayload): SearchArtifact[] {
  return payload.results.map((result) => ({
    web: {
      title: result.title,
      uri: result.url,
    },
    snippet: result.snippet,
  }));
}

// ---------------------------------------------------------------------------
// Clean-up of text that was scraped or assembled from search-result snippets
// ---------------------------------------------------------------------------

const CJK_AND_FULLWIDTH = '\\u3400-\\u9fff\\u3000-\\u303f\\uff00-\\uffef';
const CJK_GAP_PATTERN = new RegExp(`([${CJK_AND_FULLWIDTH}])[ \\t]+(?=[${CJK_AND_FULLWIDTH}])`, 'g');

/** Bold / link markup leaves blanks between Chinese characters ("团结政府 同床异梦"): they are not word spaces. */
export function normalizeCjkSpacing(text: string): string {
  return text.replace(CJK_GAP_PATTERN, '$1');
}

// A snippet join: " ... " between two excerpts (the blank before it may already be gone after Chinese sentence-final
// punctuation), or a leading / trailing "..." where an excerpt was cut off. "He said... nothing" is prose, not a join.
const SNIPPET_SPLICE = /(?:\s+|(?<=[。！？]))(?:\.{3,}|…|⋯)(?:\s+|$)|^\s*(?:\.{3,}|…|⋯)\s+/;
const SENTENCE_END = /(?:[!?。！？]|\.(?=\s|$))["'”’）)」』]*/g;

/**
 * Search snippets are excerpts joined with "...". The text on either side of a join is cut mid-sentence ("…大选后，没 ... 为了组成
 * 政府…"), so a sentence that runs into a join is dropped back to its last complete sentence, and the tail that follows a join
 * is dropped up to its first sentence end. Complete sentences are kept untouched; text without a join is returned as is.
 */
export function stripSnippetSplices(text: string): string {
  if (!SNIPPET_SPLICE.test(text)) return text;
  const parts = text.split(new RegExp(SNIPPET_SPLICE.source, 'g')).map((part) => part.trim());
  const kept = parts.map((part, index) => {
    if (!part) return '';
    let result = part;
    if (index > 0) {
      // Starts mid-sentence: drop through the first sentence end.
      SENTENCE_END.lastIndex = 0;
      const first = SENTENCE_END.exec(result);
      result = first ? result.slice(first.index + first[0].length).trim() : '';
    }
    if (result && index < parts.length - 1) {
      // Ends mid-sentence: keep up to the last sentence end.
      let end = -1;
      SENTENCE_END.lastIndex = 0;
      for (let match = SENTENCE_END.exec(result); match; match = SENTENCE_END.exec(result)) {
        end = match.index + match[0].length;
      }
      result = end > 0 ? result.slice(0, end).trim() : '';
    }
    return result;
  });
  return kept.filter(Boolean).join(' ');
}
