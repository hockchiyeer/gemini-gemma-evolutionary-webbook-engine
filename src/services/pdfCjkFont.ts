// CJK support for the jsPDF "High Res" export.
//
// jsPDF's built-in fonts (helvetica/times/courier) have no CJK glyphs. A real Unicode TrueType font is registered in
// the jsPDF document and every setFont() call is mapped onto it, which keeps the editorial layout (cover, TOC, cards,
// images, link annotations) and produces selectable/searchable text. CJK books are never rerouted to the reader-mode
// export: if the font cannot be loaded, a CjkFontUnavailableError is thrown and the user is told why.
//
// The font lives in src/assets/fonts (tracked by git, bundled by Vite, included in the AI Studio package). It used to
// live in public/fonts, but public/ is git-ignored and is not part of the AI Studio package, so the file was missing
// in every deployed copy and each CJK export silently fell back to the reader layout.

export const CJK_FONT_FAMILY = 'NotoSansSC';
const CJK_FONT_FILE = 'NotoSansSC-Subset.ttf';

export class CjkFontUnavailableError extends Error {
  constructor(public readonly attempts: string[]) {
    super(
      'The CJK font could not be loaded, so the High-Res PDF was not created. Try again, or use Print / Save as PDF.'
    );
    this.name = 'CjkFontUnavailableError';
  }
}

/** Candidate locations, most reliable first. The bundled asset URL is rewritten by Vite in dev and in builds. */
export function getCjkFontUrls(): string[] {
  const urls: string[] = [];
  try {
    urls.push(new URL('../assets/fonts/NotoSansSC-Subset.ttf', import.meta.url).href);
  } catch {
    /* import.meta.url unavailable */
  }
  // Legacy location, kept so an existing public/fonts copy keeps working.
  const base = (import.meta as any)?.env?.BASE_URL ?? '/';
  urls.push(`${base}fonts/${CJK_FONT_FILE}`);
  return urls;
}

const CJK_CHARS = '\u1100-\u11ff\u2e80-\ua4cf\uac00-\ud7af\uf900-\ufaff\uff00-\uffef';
// Punctuation that must not start a line / must not end a line (simple kinsoku rules).
const NO_LINE_START = new Set('，。₄；：！？）］｝〉》」』】〕”’…—·,.;:!?)]}%'.split(''));
const NO_LINE_END = new Set('（［｛〈《「『【〔“‘([{'.split(''));
const TOKEN_PATTERN = new RegExp(`[${CJK_CHARS}]|[^\\s${CJK_CHARS}]+|\\s+`, 'g');

/**
 * Greedy line wrapper that can break between any two CJK characters (jsPDF only breaks at spaces) while keeping
 * Latin words intact. `measure` returns the rendered width of a string in the current font/size.
 */
export function wrapMixedText(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const out: string[] = [];
  for (const paragraph of String(text ?? '').split(/\r?\n/)) {
    const tokens = paragraph.match(TOKEN_PATTERN) || [];
    let line = '';
    const flush = () => {
      if (line.trim()) out.push(line.replace(/\s+$/, ''));
      line = '';
    };
    for (const rawToken of tokens) {
      const isSpace = /^\s+$/.test(rawToken);
      if (isSpace && !line) continue;
      const token = isSpace ? ' ' : rawToken;

      if (!isSpace && measure(token) > maxWidth) {
        // A single Latin run wider than the line (long URL etc.): split it per character.
        for (const ch of token) {
          if (line && measure(line + ch) > maxWidth) flush();
          line += ch;
        }
        continue;
      }

      if (line && measure(line + token) > maxWidth) {
        if (isSpace) continue;
        const prevChar = line.slice(-1);
        if (NO_LINE_START.has(token[0]) || NO_LINE_END.has(prevChar)) {
          line += token; // keep the punctuation attached rather than orphaning it
          continue;
        }
        flush();
      }
      line += token;
    }
    flush();
    if (!paragraph.trim()) out.push('');
  }
  return out.length ? out : [''];
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Rejects HTML (Vite's SPA fallback answers 200 for missing files), CFF/OTF fonts and truncated data. */
export function assertUsableTrueType(bytes: Uint8Array): void {
  if (bytes.length < 1024) throw new Error('CJK font file is missing or truncated.');
  const tag = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const isTrueType = (bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0) || tag === 'true';
  if (tag === 'OTTO') throw new Error('CJK font is a CFF-based OpenType file; jsPDF needs a TrueType (glyf) .ttf.');
  if (!isTrueType) throw new Error('CJK font file is not a TrueType font (is src/assets/fonts/NotoSansSC-Subset.ttf missing?).');
}

let cachedFontBase64: string | null = null;

async function fetchFontBytes(url: string): Promise<Uint8Array> {
  if (url.startsWith('file:')) {
    // Node (server-side tests / scripts): fetch() cannot read file: URLs.
    const fsModule = 'node:fs/promises';
    const urlModule = 'node:url';
    const { readFile } = await import(/* @vite-ignore */ fsModule);
    const { fileURLToPath } = await import(/* @vite-ignore */ urlModule);
    return new Uint8Array(await readFile(fileURLToPath(url)));
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`request failed (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

export async function loadCjkFontBase64(urls: string[] = getCjkFontUrls()): Promise<string> {
  if (cachedFontBase64) return cachedFontBase64;
  const attempts: string[] = [];
  for (const url of urls) {
    try {
      const bytes = await fetchFontBytes(url);
      assertUsableTrueType(bytes);
      cachedFontBase64 = toBase64(bytes);
      return cachedFontBase64;
    } catch (err) {
      attempts.push(`${url}: ${(err as Error)?.message || err}`);
    }
  }
  throw new CjkFontUnavailableError(attempts);
}

/**
 * Registers the font and routes every setFont()/splitTextToSize() call of the existing drawing code through it.
 * The font has a single weight, so bold/italic requests render in the regular weight (hierarchy is carried by size
 * and colour).
 */
export function registerCjkFont(doc: any, fontBase64: string): void {
  doc.addFileToVFS(CJK_FONT_FILE, fontBase64);
  doc.addFont(CJK_FONT_FILE, CJK_FONT_FAMILY, 'normal');

  const originalSetFont = doc.setFont.bind(doc);
  doc.setFont = (..._args: unknown[]) => originalSetFont(CJK_FONT_FAMILY, 'normal');
  doc.setFont(CJK_FONT_FAMILY, 'normal');

  doc.splitTextToSize = (text: string | string[], maxWidth: number): string[] => {
    const measure = (s: string) => doc.getTextWidth(s);
    const parts = Array.isArray(text) ? text : [text];
    return parts.flatMap((part) => wrapMixedText(part, maxWidth, measure));
  };
}
