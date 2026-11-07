export const DEFAULT_DOCUMENT_TITLE = 'Evolutionary Web Book Engine';

/** Default display budget for a cover-page title (a CJK character counts as two units). */
export const COVER_TITLE_MAX_UNITS = 90;

const ELLIPSIS = '…';
const CJK_CHAR = /[ᄀ-ᇿ⺀-꓏가-힯豈-﫿＀-￯]/;
// Characters after which a title can be cut cleanly (clause boundaries), Latin and CJK.
const CLAUSE_BOUNDARY = /[,;:，；：、。—–]|\s[-|(]\s?/;
// Dangling words/punctuation that make a clipped title read as unfinished.
const TRAILING_CONNECTOR = /(?:[\s,;:，；：、\-–—&/(]+|\s(?:and|or|of|the|a|an|to|in|on|for|with|by|vs\.?|as|at|are|is)\s*)$/i;

export function getWebBookDocumentTitle(topic?: string | null): string {
  const normalizedTopic = typeof topic === 'string' ? topic.trim() : '';
  return normalizedTopic || DEFAULT_DOCUMENT_TITLE;
}

/** Display width: CJK glyphs are twice as wide as Latin ones when `weighted`, otherwise every character counts once. */
function unitsOf(text: string, weighted = true): number {
  let units = 0;
  for (const ch of text) units += weighted && CJK_CHAR.test(ch) ? 2 : 1;
  return units;
}

/** Longest prefix of `text` whose width is within `maxUnits`. */
function prefixWithinUnits(text: string, maxUnits: number, weighted = true): string {
  let units = 0;
  let out = '';
  for (const ch of text) {
    units += weighted && CJK_CHAR.test(ch) ? 2 : 1;
    if (units > maxUnits) break;
    out += ch;
  }
  return out;
}

function stripDanglingTail(text: string): string {
  let previous = '';
  let current = text.trimEnd();
  while (current !== previous) {
    previous = current;
    current = current.replace(TRAILING_CONNECTOR, '').trimEnd();
  }
  return current;
}

/**
 * Shortens an over-long title to a complete-looking one: the cut lands on a clause (or, failing that, word) boundary,
 * dangling connectors are dropped and a single ellipsis marks the omission. Titles that already fit are returned
 * unchanged. Deterministic and offline, so every export (PDF, JPG, on-screen cover) shows the same title.
 */
export function summarizeTitle(title?: string | null, maxUnits: number = COVER_TITLE_MAX_UNITS, weighted = true): string {
  const text = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim() : '';
  if (!text || unitsOf(text, weighted) <= maxUnits) return text;

  const budget = Math.max(8, maxUnits - 1); // leave room for the ellipsis
  const head = prefixWithinUnits(text, budget, weighted);
  const nextChar = text.charAt(head.length);
  const cutInsideWord = nextChar !== '' && !/\s/.test(nextChar) && !CJK_CHAR.test(nextChar) && !CJK_CHAR.test(head.slice(-1));
  const wordSafe = cutInsideWord ? head.replace(/\s*\S*$/, '') : head;

  // Prefer the last clause boundary if it keeps at least half of the budget; otherwise the last word boundary.
  let cut = wordSafe;
  let boundaryEnd = -1;
  const clause = new RegExp(CLAUSE_BOUNDARY.source, 'g');
  for (let m = clause.exec(wordSafe); m; m = clause.exec(wordSafe)) boundaryEnd = m.index;
  if (boundaryEnd > 0 && unitsOf(wordSafe.slice(0, boundaryEnd), weighted) >= budget / 2) {
    cut = wordSafe.slice(0, boundaryEnd);
  }

  const cleaned = stripDanglingTail(cut);
  return cleaned ? `${cleaned}${ELLIPSIS}` : `${prefixWithinUnits(text, budget, weighted).trimEnd()}${ELLIPSIS}`;
}

/** Clips a label to `maxChars` characters without cutting a word in half; adds an ellipsis only when text was removed. */
export function clipLabelAtWordBoundary(text: string, maxChars: number): string {
  return summarizeTitle(text, maxChars, false);
}

