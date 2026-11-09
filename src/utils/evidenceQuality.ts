// Quality gates for evidence gathered from the open web, used when a book is compiled offline from search results (no AI model).
// The scraper returns whatever the search engine found: a news site's "About us" page, an activities listing, bibliography
// lines. Without a gate they became whole chapters ("公司简介", "喜欢跑步、健身及挑战障碍赛的朋友看过来").

const CHROME_PATH_SEGMENT = /^(about|about-?us|aboutus|contact|contact-?us|contactus|privacy|privacy-?policy|terms|terms-?of-?(use|service)|careers?|advertis(e|ing)|activit(y|ies)|[a-z-]*-activit(y|ies)|sitemap|subscribe|login|sign-?in|register|faq|help|disclaimer|cookies?)$/i;
const CHROME_TITLE = /(^|\s|[|\-–—])(关于我们|關於我們|公司简介|公司簡介|联系我们|聯繫我們|隐私政策|隱私政策|服务条款|服務條款|广告服务|廣告服務|活动|活動)(\s|$|[|\-–—])|^(about( us)?|contact( us)?|privacy policy|terms( of (use|service))?|advertise|careers)\b/i;

/** A page that is part of a site's furniture, not an article: /about, /contact, /…-activities, "公司简介" ... */
export function isSiteChromePage(url: string, title = ''): boolean {
  try {
    const segments = new URL(url).pathname.split('/').map((s) => s.trim()).filter(Boolean);
    const last = segments[segments.length - 1] || '';
    if (last && CHROME_PATH_SEGMENT.test(last.replace(/\.(html?|php|aspx?)$/i, ''))) return true;
  } catch {
    // not a URL: judge by the title alone
  }
  return CHROME_TITLE.test(String(title || '').trim());
}

/** A bibliography line ("1Rugayah M."Public Enterprises" In Jomo K. Boulder Westview Press 1995 pp.64~65.") is not prose. */
export function isBibliographicCitation(text: string): boolean {
  const t = String(text ?? '');
  const markers = [
    /\bpp?\.\s?\d/i,
    /\bvol\.?\s?\d/i,
    /\bno\.\s?\d/i,
    /\b(?:press|publishers?|university)\b[^.]{0,40}\b(?:19|20)\d{2}\b/i,
    /^\s*\d{1,2}\s*[A-Z][A-Za-z'’-]+\s+[A-Z]\.?\s*["“”]/,
    /\bdoi:\s*10\./i,
  ];
  return markers.filter((m) => m.test(t)).length >= 2;
}

const FLAT = /[^\p{L}\p{N}]+/gu;

function bigramSet(text: string): Set<string> {
  const flat = String(text ?? '').toLowerCase().replace(FLAT, '');
  const out = new Set<string>();
  for (let i = 0; i < flat.length - 1; i += 1) out.add(flat.slice(i, i + 2));
  return out;
}

/** Share (0..1) of the topic's character pairs that occur in the page text. */
export function topicOverlap(topic: string, pageText: string): number {
  const wanted = bigramSet(topic);
  if (wanted.size === 0) return 1;
  const have = bigramSet(pageText);
  let hit = 0;
  for (const g of wanted) if (have.has(g)) hit += 1;
  return hit / wanted.size;
}

export const MIN_TOPIC_OVERLAP = 0.4;
const MIN_PAGES_AFTER_FILTER = 2;

const CJK_ANY = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/;

/**
 * Drops site-furniture pages and pages that share too little with the topic (a page that only repeats the country name of a
 * topic about its politics). The filter never empties the book: when it would leave fewer than two pages, every page is kept.
 */
export function selectRelevantPages<T extends { url?: string; title?: string; content?: string }>(topic: string, pages: T[]): T[] {
  const withoutChrome = pages.filter((page) => !isSiteChromePage(page.url || '', page.title || ''));
  const isCjk = CJK_ANY.test(topic);
  const relevant = withoutChrome.filter((page) =>
    !isCjk || topicOverlap(topic, `${page.title || ''} ${page.content || ''}`) >= MIN_TOPIC_OVERLAP || bigramSet(topic).size < 6
  );
  if (relevant.length >= MIN_PAGES_AFTER_FILTER) return relevant;
  if (withoutChrome.length >= MIN_PAGES_AFTER_FILTER) return withoutChrome;
  return pages;
}

/**
 * A "definition" that is really the rest of a news sentence: "颜登逸: 于9月20日在隆雪华堂…开幕礼致辞时，如是说道。" came from splitting
 * "颜登逸是于9月20日…" at the 是. A definition explains what the term is; a description that opens with 于 / a date, or ends in a
 * reporting verb ("…如是说道"), only says when and where someone spoke.
 */
export function isEventFragmentDefinition(term: string, description: string): boolean {
  const text = String(description ?? '').trim();
  if (!text) return false;
  if (/^于/.test(text)) return true;
  if (/^(?:在|从|自)?\s*[\d一二三四五六七八九十]{1,4}\s*[年月日号]/.test(text)) return true;
  return /(?:如是说道|表示|指出|说道|强调道?)[，,。.]?\s*[”"」』]?\s*$/.test(text) && String(term ?? '').trim().length <= 6;
}
