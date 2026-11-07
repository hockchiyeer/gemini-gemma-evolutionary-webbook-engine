import type { SearchFallbackResult } from '../../src/types.ts';
import { containsPoisonBoilerplate, isPageChromeText } from '../../src/utils/webBookRender.ts';
import { CJK_CHAR_GLOBAL_PATTERN, calculateTextSimilarity, classifySourceReliability, type SourceReliabilityTier } from '../../src/services/searchFallbackShared.ts';
import { collapseWhitespace, decodeHtmlEntities } from './shared.ts';

/**
 * Search-result snippets are one to three sentences long, so a Web-book written from them alone (no Gemini key) comes out
 * as a handful of sentences per chapter. This module reads the result pages themselves and keeps their readable body
 * paragraphs as `excerpt`, which is what gives the offline book real chapter text.
 */

export const PAGE_FETCH_MAX_PAGES = 10;
export const PAGE_FETCH_CONCURRENCY = 4;
export const PAGE_FETCH_TIMEOUT_MS = 6000;
export const PAGE_FETCH_TOTAL_BUDGET_MS = 18000;
export const PAGE_FETCH_MAX_BYTES = 1_500_000;
export const PAGE_EXCERPT_MAX_CHARS = 4800;
/** Same-site pages (history / about / overview) read from the best result pages, on top of the search results themselves. */
export const PAGE_FOLLOW_MAX_SOURCES = 3;
export const PAGE_FOLLOW_MAX_LINKS = 4;
/**
 * A page's links are only followed when the page itself is clearly about the topic (this share of the topic's words / Chinese
 * character pairs appear in it). "Universiti Malaya" alone is on every faculty page of the university: matching it must not
 * be enough to follow that faculty's own "overview" link into text about something else.
 */
export const PAGE_FOLLOW_MIN_TOPIC_COVERAGE = 0.6;
/** A followed page that yields less readable text than this is navigation or a stub, not a source. */
const FOLLOW_MIN_EXCERPT_CHARS = 400;
const FOLLOW_MIN_EXCERPT_CJK_CHARS = 150;
const MAX_PARAGRAPHS_PER_PAGE = 12;
const MIN_PARAGRAPH_LATIN_CHARS = 70;
const MIN_PARAGRAPH_CJK_CHARS = 28;

// Sites that serve a login wall or a script-only shell to a plain HTTP client: fetching them only yields page chrome.
const UNREADABLE_HOSTS = [
  'facebook.com', 'fb.com', 'instagram.com', 'twitter.com', 'x.com', 'linkedin.com', 'tiktok.com', 'youtube.com',
  'youtu.be', 'pinterest.com', 'reddit.com', 'scribd.com', 'quora.com', 'threads.net', 'weibo.com',
];
const UNREADABLE_EXTENSION = /\.(?:pdf|docx?|xlsx?|pptx?|zip|rar|7z|png|jpe?g|gif|webp|svg|mp[34]|avi|mov)(?:$|[?#])/i;

export type PageFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

export interface PageExcerptOptions {
  fetchImpl?: PageFetch;
  maxPages?: number;
  concurrency?: number;
  timeoutMs?: number;
  totalBudgetMs?: number;
  maxBytes?: number;
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host.includes(':')) return host === '::1' || host === '::' || /^f[cd][0-9a-f]{2}:/.test(host) || host.startsWith('fe80:');
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return false;
}

/** True for public http(s) pages a plain GET can read; false for private addresses, login-walled sites and binary files. */
export function isFetchablePageUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    if (isPrivateHost(host)) return false;
    if (UNREADABLE_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`))) return false;
    if (UNREADABLE_EXTENSION.test(url.pathname + url.search)) return false;
    return true;
  } catch {
    return false;
  }
}

function sniffCharset(contentType: string | null, head: string): string {
  const fromHeader = contentType?.match(/charset\s*=\s*["']?([\w-]+)/i)?.[1];
  const fromMeta = head.match(/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i)?.[1] || head.match(/<meta[^>]+content=["'][^"']*charset=([\w-]+)/i)?.[1];
  return (fromHeader || fromMeta || 'utf-8').toLowerCase();
}

/** Decodes a response body with the charset it declares (GBK and Big5 pages are common for Chinese sources). */
export function decodeHtmlBytes(bytes: Uint8Array, contentType: string | null): string {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048));
  const charset = sniffCharset(contentType, head);
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function pickMainRegion(html: string): string {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|iframe|form|nav|header|footer|aside|button|select|template)\b[\s\S]*?<\/\1>/gi, ' ');
  const region = stripped.match(/<(article|main)\b[\s\S]*?<\/\1>/i)
    || stripped.match(/<div[^>]+(?:id|class)=["'][^"']*(?:mw-content-text|post-content|entry-content|article-body|article-content|main-content|content-body)[^"']*["'][\s\S]*/i);
  return region ? region[0] : stripped;
}

function cleanBlockText(block: string): string {
  return collapseWhitespace(decodeHtmlEntities(block.replace(/<[^>]+>/g, ' ')))
    .replace(/\[\s*(?:\d+|edit|citation needed|note \d+)\s*\]/gi, '')
    .replace(/\s+([,.;:!?，。；：！？])/g, '$1')
    .trim();
}

function paragraphsOf(region: string): string[] {
  return [...region.matchAll(/<(p|li|blockquote)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((match) => cleanBlockText(match[2]));
}

/**
 * Many site builders (Wix, Elementor, hand-made pages) put text in <div>/<span>/<td>/<h*> instead of <p>. Leaf blocks
 * (no nested tags) of that kind are used when the page has too few <p> paragraphs.
 */
function leafBlocksOf(region: string): string[] {
  return [...region.matchAll(/<(div|span|td|section|h[1-6])\b[^>]*>([^<]{40,})<\/\1>/gi)].map((match) => cleanBlockText(match[2]));
}

/** The page's own summary (meta / Open Graph description): a readable few sentences even when the body is script-rendered. */
function metaDescriptionOf(html: string): string {
  const tag = html.match(/<meta\b[^>]*(?:name|property)=["'](?:description|og:description)["'][^>]*>/i)?.[0] || '';
  const content = tag.match(/content=["']([^"']+)["']/i)?.[1] || '';
  return cleanBlockText(content);
}

function queryTerms(...texts: string[]): { words: string[]; bigrams: string[] } {
  const words = new Set<string>();
  const bigrams = new Set<string>();
  for (const text of texts) {
    (text.toLowerCase().match(/[a-z0-9]{3,}/g) || []).forEach((word) => words.add(word));
    for (const run of text.match(/[㐀-鿿豈-﫿]+/g) || []) {
      for (let index = 0; index + 1 < run.length; index += 1) bigrams.add(run.slice(index, index + 2));
    }
  }
  return { words: [...words], bigrams: [...bigrams] };
}

function isReadableParagraph(paragraph: string): boolean {
  const cjk = (paragraph.match(CJK_CHAR_GLOBAL_PATTERN) || []).length;
  const long = cjk >= MIN_PARAGRAPH_CJK_CHARS || (cjk === 0 && paragraph.length >= MIN_PARAGRAPH_LATIN_CHARS)
    || (cjk > 0 && paragraph.length >= MIN_PARAGRAPH_LATIN_CHARS * 1.5);
  if (!long) return false;
  if (isPageChromeText(paragraph) || containsPoisonBoilerplate(paragraph)) return false;
  // Link lists and menus: mostly short capitalised fragments with almost no sentence punctuation.
  const sentenceMarks = (paragraph.match(/[.!?。！？;；]/g) || []).length;
  return sentenceMarks >= 1 || paragraph.length >= 160;
}

/**
 * Readable body text of an HTML page: the main/article region's paragraphs, minus menus, cookie notices and other page
 * chrome. When `relevantTo` is given, the text starts at the first paragraph that mentions what was searched for (so
 * a page's unrelated lead-in is skipped) and a page that never mentions it yields nothing. Later paragraphs are kept
 * even when they say "the society" instead of repeating the name: they belong to the same article.
 */
export function extractReadableText(html: string, relevantTo: string[] = [], maxChars = PAGE_EXCERPT_MAX_CHARS): string {
  const terms = queryTerms(...relevantTo);
  const hasTerms = terms.words.length + terms.bigrams.length > 0;
  const isRelevant = (paragraph: string): boolean => {
    const lowered = paragraph.toLowerCase();
    return terms.words.some((word) => lowered.includes(word)) || terms.bigrams.some((pair) => paragraph.includes(pair));
  };

  const region = pickMainRegion(html);
  let candidates = paragraphsOf(region);
  if (candidates.filter(isReadableParagraph).length < 2) candidates = [...candidates, ...leafBlocksOf(region)];
  if (candidates.filter(isReadableParagraph).length === 0) candidates = [metaDescriptionOf(html)];
  const readable = candidates.filter(isReadableParagraph);
  const start = hasTerms ? readable.findIndex(isRelevant) : 0;
  if (start < 0) return '';

  const kept: string[] = [];
  let length = 0;
  for (const paragraph of readable.slice(start)) {
    if (kept.length >= MAX_PARAGRAPHS_PER_PAGE || length >= maxChars) break;
    if (kept.some((existing) => existing === paragraph || calculateTextSimilarity(existing, paragraph) >= 0.85)) continue;
    const clipped = paragraph.length > 900 ? `${paragraph.slice(0, 900).replace(/\s+\S*$/, '')}…` : paragraph;
    kept.push(clipped);
    length += clipped.length;
  }
  return kept.join('\n\n').slice(0, maxChars);
}

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  return bytes.length > maxBytes ? bytes.subarray(0, maxBytes) : bytes;
}

const EMPTY_PAGE = { excerpt: '', html: '' };

async function fetchPage(
  url: string,
  relevantTo: string[],
  options: Required<PageExcerptOptions>,
  deadline: number
): Promise<{ excerpt: string; html: string }> {
  const remaining = deadline - Date.now();
  if (remaining <= 250) return EMPTY_PAGE;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(options.timeoutMs, remaining));
  try {
    const response = await options.fetchImpl(url, {
      headers: {
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
        'accept-language': 'en-US,en;q=0.9,zh-CN;q=0.8,ms;q=0.7',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
      },
      signal: controller.signal,
    });
    if (!response.ok) return EMPTY_PAGE;
    const contentType = response.headers.get('content-type');
    if (contentType && !/html|xml|text\/plain/i.test(contentType)) return EMPTY_PAGE;
    const html = decodeHtmlBytes(await readBounded(response, options.maxBytes), contentType);
    return { excerpt: extractReadableText(html, relevantTo), html };
  } catch {
    return EMPTY_PAGE;
  } finally {
    clearTimeout(timer);
  }
}

// Paths and link texts of pages that usually hold a society's / organisation's / subject's own account of itself.
const FOLLOW_LINK_HINT = /(?:about|history|histor|background|overview|introduction|profile|who-we-are|mission|activit|committee|sejarah|tentang|latar|pengenalan|关于|關於|历史|歷史|简介|簡介|沿革|介绍|介紹|概况|概況|学会|學會)/i;

/**
 * Wiki revision histories, special pages, talk / user pages, feeds and login endpoints: they say "history" or "about" without
 * being an account of the subject, and their text is edit logs and chrome.
 */
function isSystemUrl(url: URL): boolean {
  if (/(?:^|&)(?:action|oldid|diff|veaction|printable|feed)=/i.test(url.search.replace(/^\?/, ''))) return true;
  let path = url.pathname;
  try { path = decodeURIComponent(path); } catch { /* keep the raw path */ }
  return /\/w\/index\.php|\/wp-(?:login|admin|json)|\/feed\/?$|\/(?:Special|Talk|User|User_talk|Help|Category|Template|Portal|File|Wikipedia|Istimewa|Perbincangan|Pengguna|Bantuan|Kategori|Fail):/i.test(path);
}

/** Share of the topic's words and Chinese character pairs found in `text` (1 when the topic has none to look for). */
function topicCoverage(text: string, terms: { words: string[]; bigrams: string[] }): number {
  const total = terms.words.length + terms.bigrams.length;
  if (total === 0) return 1;
  const lowered = text.toLowerCase();
  const hits = terms.words.filter((word) => lowered.includes(word)).length + terms.bigrams.filter((pair) => text.includes(pair)).length;
  return hits / total;
}

/** Same-site links whose text or path says "about / history / overview": where a site keeps its substantive text. */
export function extractFollowLinks(html: string, baseUrl: string, limit = PAGE_FOLLOW_MAX_LINKS): Array<{ url: string; title: string }> {
  let base: URL;
  try { base = new URL(baseUrl); } catch { return []; }
  const baseHost = base.hostname.replace(/^www\./, '');
  const found = new Map<string, { url: string; title: string; score: number; order: number }>();

  for (const match of html.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let target: URL;
    try { target = new URL(decodeHtmlEntities(match[1]), base); } catch { continue; }
    target.hash = '';
    if (!/^https?:$/.test(target.protocol) || target.hostname.replace(/^www\./, '') !== baseHost) continue;
    if (target.href === base.href || target.pathname === base.pathname || target.pathname === '/' || !isFetchablePageUrl(target.href)) continue;
    if (isSystemUrl(target)) continue;

    const text = cleanBlockText(match[2]);
    let path = target.pathname;
    try { path = decodeURIComponent(path); } catch { /* keep the raw path */ }
    const textHit = text.length >= 2 && text.length <= 80 && FOLLOW_LINK_HINT.test(text);
    const pathHit = FOLLOW_LINK_HINT.test(path);
    if (!textHit && !pathHit) continue;

    const score = (textHit ? 2 : 0) + (pathHit ? 1 : 0) - (target.search ? 1 : 0);
    const key = target.href;
    if (!found.has(key) || score > found.get(key)!.score) {
      found.set(key, { url: key, title: text.length >= 2 && text.length <= 80 ? text : '', score, order: found.get(key)?.order ?? found.size });
    }
  }
  return [...found.values()].sort((a, b) => b.score - a.score || a.order - b.order).slice(0, limit).map(({ url, title }) => ({ url, title }));
}

const TIER_RANK: Record<SourceReliabilityTier, number> = { high: 0, medium: 1, low: 2 };

/**
 * Adds the readable body text of the first result pages as `excerpt`. Never throws and never drops a result: a page that
 * cannot be read (blocked, slow, binary, off-topic) keeps its snippet, so this can only add evidence.
 */
export async function enrichResultsWithPageExcerpts(
  results: ReadonlyArray<SearchFallbackResult>,
  query: string,
  overrides: PageExcerptOptions = {}
): Promise<SearchFallbackResult[]> {
  const options: Required<PageExcerptOptions> = {
    fetchImpl: overrides.fetchImpl || ((url, init) => fetch(url, init)),
    maxPages: overrides.maxPages ?? PAGE_FETCH_MAX_PAGES,
    concurrency: overrides.concurrency ?? PAGE_FETCH_CONCURRENCY,
    timeoutMs: overrides.timeoutMs ?? PAGE_FETCH_TIMEOUT_MS,
    totalBudgetMs: overrides.totalBudgetMs ?? PAGE_FETCH_TOTAL_BUDGET_MS,
    maxBytes: overrides.maxBytes ?? PAGE_FETCH_MAX_BYTES,
  };

  const enriched = results.map((result) => ({ ...result }));
  const targets = enriched
    .map((result, index) => ({ result, index }))
    .filter(({ result }) => !result.excerpt && isFetchablePageUrl(result.url))
    // The most reliable hosts are read first, so the page allowance goes to the best sources, not the first ones listed.
    .sort((a, b) => TIER_RANK[classifySourceReliability(a.result.url)] - TIER_RANK[classifySourceReliability(b.result.url)] || a.index - b.index)
    // One page per host first, so a single site's many results cannot use up the whole fetch allowance.
    .filter(({ result }, position, all) => all.findIndex((other) => new URL(other.result.url).hostname === new URL(result.url).hostname) === position)
    .slice(0, options.maxPages);

  const deadline = Date.now() + options.totalBudgetMs;
  const htmlByUrl = new Map<string, string>();
  const runPool = async <T,>(items: T[], task: (item: T) => Promise<void>) => {
    let next = 0;
    const worker = async () => { while (next < items.length) await task(items[next++]); };
    await Promise.all(Array.from({ length: Math.min(options.concurrency, items.length) }, worker));
  };

  await runPool(targets, async ({ result }) => {
    const page = await fetchPage(result.url, [query, result.title], options, deadline);
    if (page.excerpt) {
      result.excerpt = page.excerpt;
      htmlByUrl.set(result.url, page.html);
    }
  });

  // Second pass: the best readable pages usually link to their own history / about pages, which hold far more substance than
  // a landing page. They are added as extra results (never replacing one) and are read without a topic filter, since a
  // same-site "About" page often says "the society" instead of repeating the name.
  const known = new Set(enriched.map((result) => result.url));
  const topic = queryTerms(query);
  const followTargets: Array<{ url: string; title: string }> = [];
  enriched
    .filter((result) => result.excerpt && htmlByUrl.has(result.url) && classifySourceReliability(result.url) !== 'low')
    .filter((result) => topicCoverage(`${result.title} ${result.excerpt}`, topic) >= PAGE_FOLLOW_MIN_TOPIC_COVERAGE)
    .sort((a, b) => TIER_RANK[classifySourceReliability(a.url)] - TIER_RANK[classifySourceReliability(b.url)])
    .slice(0, PAGE_FOLLOW_MAX_SOURCES)
    .forEach((result) => {
      for (const link of extractFollowLinks(htmlByUrl.get(result.url) || '', result.url, 2)) {
        if (followTargets.length < PAGE_FOLLOW_MAX_LINKS && !known.has(link.url)) {
          known.add(link.url);
          followTargets.push(link);
        }
      }
    });

  const followed: SearchFallbackResult[] = [];
  await runPool(followTargets, async (link) => {
    const page = await fetchPage(link.url, [], options, deadline);
    const cjkChars = (page.excerpt.match(CJK_CHAR_GLOBAL_PATTERN) || []).length;
    if (page.excerpt.length < FOLLOW_MIN_EXCERPT_CHARS && cjkChars < FOLLOW_MIN_EXCERPT_CJK_CHARS) return;
    const host = new URL(link.url).hostname.replace(/^www\./, '');
    followed.push({
      title: link.title || `${host} ${new URL(link.url).pathname}`,
      url: link.url,
      snippet: page.excerpt.split('\n\n')[0].slice(0, 240),
      domain: host,
      excerpt: page.excerpt,
      source: results[0]?.source,
    });
  });
  // Completion order is network order; the book must not depend on it.
  followed.sort((a, b) => followTargets.findIndex((t) => t.url === a.url) - followTargets.findIndex((t) => t.url === b.url));

  return [...enriched, ...followed];
}
