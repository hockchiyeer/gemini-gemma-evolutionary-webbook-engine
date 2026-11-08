// Two clean-ups applied to every chapter before it is shown or exported, whatever produced it (Gemini, a local model, offline search):
//  1. The chapter body must not repeat the glossary ("核心概念") and the sub-topic list ("小标题"), which are printed as their own
//     sections right after it. Small models paste the same definitions and analyses into the body as well, so the book says everything twice.
//  2. The visual-concept caption must be in the language of the book (models often write it in English).
import { detectTextLocale } from '../services/exportLabels.ts';

const CJK_ANY = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/;
const WORDS_ONLY = /[^\p{L}\p{N}]+/gu;

function bigrams(text: string): Set<string> {
  const flat = String(text ?? '').toLowerCase().replace(WORDS_ONLY, '');
  const out = new Set<string>();
  if (flat.length < 2) { if (flat) out.add(flat); return out; }
  for (let i = 0; i < flat.length - 1; i += 1) out.add(flat.slice(i, i + 2));
  return out;
}

/** Share of the bigrams of `a` that also occur in `b` (0..1). */
function containment(a: Set<string>, b: Set<string>): number {
  if (a.size === 0) return 0;
  let hit = 0;
  for (const g of a) if (b.has(g)) hit += 1;
  return hit / a.size;
}

function plain(text: string): string {
  return String(text ?? '').replace(/[*_`#]/g, '').replace(/\s+/g, ' ').trim();
}

/** "网红律师 (Influencer Lawyer)" -> ["网红律师", "网红律师(influencerlawyer)"] as comparison keys. */
function labelKeys(label: string): string[] {
  const base = plain(label).replace(/[:：]\s*$/, '');
  const noBracket = base.replace(/[（(][^）)]*[）)]?\s*$/, '').trim();
  const flat = (s: string) => s.toLowerCase().replace(WORDS_ONLY, '');
  return [...new Set([flat(base), flat(noBracket)].filter((k) => k.length >= 2))];
}

const GENERIC_SECTION_HEADER = /^(核心概念(定义)?|概念定义|定义与分析|人物定义与分析|关键概念|小标题|核心概念|核心觀念|主要概念|key (concepts?|terms?)( definitions?)?|core concepts?( definitions?)?|definitions?|sub-?topics?)\s*[:：]?$/i;

/** Removes from the chapter body the paragraphs that only restate a definition or a sub-topic analysis given in their own section. */
export function removeRepeatedSections(
  content: string,
  definitions: Array<{ term?: string; description?: string }> = [],
  subTopics: Array<{ title?: string; summary?: string }> = []
): string {
  const original = String(content ?? '').trim();
  if (!original) return original;

  const entries = [
    ...definitions.map((d) => ({ label: d?.term || '', text: plain(d?.description || '') })),
    ...subTopics.map((s) => ({ label: s?.title || '', text: plain(s?.summary || '') })),
  ].filter((entry) => entry.label && entry.text);
  if (entries.length === 0) return original;

  const prepared = entries.map((entry) => ({ keys: labelKeys(entry.label), grams: bigrams(entry.text), length: entry.text.length }));
  const paragraphs = original.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const flat = (s: string) => s.toLowerCase().replace(WORDS_ONLY, '');

  const keep = paragraphs.map((paragraph, index) => {
    if (index === 0) return true; // the opening paragraph always stays
    const text = plain(paragraph);
    const flatText = flat(text);
    if (GENERIC_SECTION_HEADER.test(text)) return false;
    const paragraphGrams = bigrams(text);
    for (const entry of prepared) {
      // a bare heading that is just the term / sub-topic title
      if (text.length <= 80 && entry.keys.includes(flatText)) return false;
      const startsWithLabel = entry.keys.some((key) => flatText.startsWith(key));
      const covered = containment(entry.grams, paragraphGrams); // how much of the glossary text sits in this paragraph
      const ratio = Math.min(text.length, entry.length) / Math.max(text.length, entry.length);
      if (startsWithLabel && covered >= 0.5) return false;
      if (ratio >= 0.5 && covered >= 0.6 && containment(paragraphGrams, entry.grams) >= 0.5) return false;
    }
    return true;
  });

  // a heading left without its paragraph (the paragraph was dropped, the short heading above it was not): drop it too
  const result: string[] = [];
  paragraphs.forEach((paragraph, index) => {
    if (!keep[index]) return;
    result.push(paragraph);
  });
  const cleaned: string[] = [];
  result.forEach((paragraph, i) => {
    const isHeadingLike = i > 0 && paragraph.length <= 40 && !/[。！？.!?]$/.test(plain(paragraph));
    const next = result[i + 1];
    if (isHeadingLike && next === undefined) return; // dangling heading at the end
    cleaned.push(paragraph);
  });
  return cleaned.length > 0 ? cleaned.join('\n\n') : original;
}

/** Drops repeated entries (same label, after ignoring case, spacing and brackets), keeping the first. */
export function dedupeByLabel<T>(items: T[], getLabel: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const keys = labelKeys(getLabel(item));
    if (keys.length > 0 && keys.some((k) => seen.has(k))) continue;
    keys.forEach((k) => seen.add(k));
    out.push(item);
  }
  return out;
}

const ENGLISH_HINT_WORDS = new Set(['the', 'of', 'a', 'an', 'and', 'with', 'in', 'on', 'for', 'to', 'depicting', 'showing', 'image', 'illustration', 'photo', 'diagram', 'scene', 'concept', 'against', 'between', 'at']);

function looksEnglish(seed: string): boolean {
  const words = seed.toLowerCase().match(/[a-z']+/g) || [];
  return words.length >= 2 && words.some((w) => ENGLISH_HINT_WORDS.has(w));
}

/**
 * The visual-concept caption in the language of the book. A caption written in another language than the book (typically English in a
 * Chinese, Japanese, Korean, Malay, Spanish, French or German book) is replaced by the chapter title, which is always in the book's language.
 */
export function localizeVisualSeed(seed: string, context: { title: string; sample: string }): string {
  const caption = plain(seed);
  const title = plain(context.title);
  if (!caption || !title) return caption || title;
  const sample = `${context.title}\n${context.sample}`;
  const locale = detectTextLocale(sample);
  if (locale === 'en') return caption;
  if (['zh-Hans', 'zh-Hant', 'ja', 'ko'].includes(locale)) {
    return CJK_ANY.test(caption) ? caption : title;
  }
  return looksEnglish(caption) ? title : caption;
}
