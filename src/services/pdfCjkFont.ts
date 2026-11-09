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
  readonly attempts: string[];

  constructor(attempts: string[]) {
    // The first failure is shown in the red export banner so that a hosted (AI Studio) failure can be diagnosed without DevTools.
    const firstReason = attempts.length > 0 ? ` Reason: ${attempts[0].slice(0, 160)}` : '';
    super(
      `The CJK font could not be loaded, so the High-Res PDF was not created. Try again, or use Print / Save as PDF.${firstReason}`
    );
    this.name = 'CjkFontUnavailableError';
    this.attempts = attempts;
  }
}

/**
 * URLs of the font file known to the bundler. A glob is used on purpose: a plain "new URL(<literal path>, import.meta.url)" makes Vite
 * resolve the file while it TRANSFORMS this module. exportService statically imports this module, so if the 17 MB font were not
 * part of a deployment that transform error would break the whole app at start-up instead of only the export. A glob that matches nothing is
 * simply empty, so a missing font ends in the clear CjkFontUnavailableError. Outside Vite (Node tests) the glob call does not exist and is guarded.
 */
function bundledFontUrls(): string[] {
  try {
    const found = import.meta.glob('../assets/fonts/NotoSansSC-Subset.ttf', { query: '?url', import: 'default', eager: true }) as Record<string, unknown>;
    return Object.values(found).filter((url): url is string => typeof url === 'string' && url.length > 0);
  } catch {
    return [];
  }
}

/** Candidate locations, most reliable first. Duplicates are removed. */
export function getCjkFontUrls(): string[] {
  const urls: string[] = [];
  try {
    // Built from a variable so that Vite does not try to resolve the file at transform time (see bundledFontUrls).
    const relative = `../assets/fonts/${CJK_FONT_FILE}`;
    urls.push(new URL(relative, import.meta.url).href);
  } catch {
    /* import.meta.url unavailable */
  }
  urls.push(...bundledFontUrls());
  // Direct location, kept so public/fonts copy works unhashed.
  const base = (import.meta as any)?.env?.BASE_URL ?? '/';
  urls.push(`${base}fonts/${CJK_FONT_FILE}`);
  return [...new Set(urls)];
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

export const CHUNK_SIZE_STANDARD = 1048576; // 1 MB (part-00.bin through part-06.bin)
export const CHUNK_SIZE_LAST = 259268;     // part-07.bin
export const EXPECTED_TOTAL_FONT_SIZE = 7599300;

export type FontProgressCallback = (status: string | null) => void;
let fontProgressListener: FontProgressCallback | null = null;
let lastProgressMessage: string | null = null;

export function setFontProgressListener(listener: FontProgressCallback | null): void {
  fontProgressListener = listener;
  if (listener && lastProgressMessage) {
    listener(lastProgressMessage);
  }
}

function notifyFontProgress(message: string | null): void {
  lastProgressMessage = message;
  if (fontProgressListener) {
    try {
      fontProgressListener(message);
    } catch {
      /* ignore */
    }
  }
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const FONT_CACHE_NAME = 'webbook-cjk-font-v2';
const MAX_FETCH_ATTEMPTS = 5;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The font is a 7.6 MB file. Hosted previews (Google AI Studio) answer such a download with "429 Too Many Requests" or a 5xx while they are
 * busy, which used to fail the export on the first try. Those statuses are retried with a growing pause (the server's Retry-After wins);
 * every other status (404, ...) fails at once and moves on to the next candidate URL.
 */
async function fetchWithRetry(
  url: string,
  maxAttempts = MAX_FETCH_ATTEMPTS,
  maxPauseMs = 10000,
  onRetry?: (attempt: number, maxAttempts: number, waitMs: number) => void
): Promise<Response> {
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(url);
    if (response.ok) return response;
    if (!RETRYABLE_STATUS.has(response.status) || attempt >= maxAttempts) {
      throw new Error(`request failed (${response.status}${attempt > 1 ? `, after ${attempt} attempts` : ''})`);
    }
    const retryAfter = Number(response.headers.get('retry-after'));
    const waitMs = Math.min(maxPauseMs, retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** (attempt - 1));
    if (onRetry) {
      onRetry(attempt, maxAttempts, waitMs);
    }
    await sleep(waitMs);
  }
}

async function readFromBrowserCache(url: string): Promise<Uint8Array | null> {
  try {
    if (typeof caches === 'undefined') return null;
    const cache = await caches.open(FONT_CACHE_NAME);
    const hit = await cache.match(url);
    return hit ? new Uint8Array(await hit.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

async function writeToBrowserCache(url: string, bytes: Uint8Array): Promise<void> {
  try {
    if (typeof caches === 'undefined') return;
    const cache = await caches.open(FONT_CACHE_NAME);
    await cache.put(url, new Response(bytes as unknown as BodyInit, { headers: { 'content-type': 'font/ttf' } }));
  } catch {
    /* quota or private mode: the font is simply downloaded again next time */
  }
}

async function fetchFontBytes(url: string): Promise<Uint8Array> {
  if (url.startsWith('file:')) {
    // Node (server-side tests / scripts): fetch() cannot read file: URLs.
    const fsModule = 'node:fs/promises';
    const urlModule = 'node:url';
    const { readFile } = await import(/* @vite-ignore */ fsModule);
    const { fileURLToPath } = await import(/* @vite-ignore */ urlModule);
    return new Uint8Array(await readFile(fileURLToPath(url)));
  }
  const cached = await readFromBrowserCache(url);
  if (cached) {
    try {
      assertUsableTrueType(cached);
      return cached;
    } catch {
      /* a bad cached copy is ignored and downloaded again */
    }
  }
  const response = await fetchWithRetry(url, MAX_FETCH_ATTEMPTS, 10000, (_attempt, _max, waitMs) => {
    notifyFontProgress(`Preparing font… retrying in ${Math.round(waitMs / 1000)}s`);
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  assertUsableTrueType(bytes);
  await writeToBrowserCache(url, bytes);
  return bytes;
}

/** The same file is listed as an absolute and as a root-relative URL; resolve and drop the duplicates so it is not requested twice. */
function distinctUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of urls) {
    let key = url;
    try {
      key = new URL(url, typeof location !== 'undefined' ? location.href : undefined).href;
    } catch {
      /* keep as given */
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
  }
  return out;
}

/**
 * The font is also shipped as ~1 MB pieces (src/assets/fonts/chunks). The hosted AI Studio preview answers a single 7 MB download with
 * "429 Too Many Requests"; small sequential requests that are cached one by one let a later attempt (or the background prefetch) fetch only
 * what is still missing, instead of starting the whole download again.
 */
function bundledFontChunkUrls(): string[] {
  try {
    const found = import.meta.glob('../assets/fonts/chunks/*.bin', { query: '?url', import: 'default', eager: true }) as Record<string, unknown>;
    return Object.keys(found)
      .sort()
      .map((key) => found[key])
      .filter((url): url is string => typeof url === 'string' && url.length > 0);
  } catch {
    return [];
  }
}

async function fetchChunkBytes(url: string, index: number, totalChunks: number): Promise<Uint8Array> {
  if (url.startsWith('file:')) {
    const fsModule = 'node:fs/promises';
    const urlModule = 'node:url';
    const { readFile } = await import(/* @vite-ignore */ fsModule);
    const { fileURLToPath } = await import(/* @vite-ignore */ urlModule);
    return new Uint8Array(await readFile(fileURLToPath(url)));
  }
  const expectedSize = totalChunks === 8 ? (index === totalChunks - 1 ? CHUNK_SIZE_LAST : CHUNK_SIZE_STANDARD) : undefined;
  const cached = await readFromBrowserCache(url);
  if (cached && (expectedSize === undefined || cached.length === expectedSize)) {
    return cached;
  }
  const response = await fetchWithRetry(url, 8, 15000, (_attempt, _max, waitMs) => {
    notifyFontProgress(`Preparing font… piece ${index + 1}/${totalChunks} (retrying in ${Math.round(waitMs / 1000)}s)`);
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length === 0) throw new Error('empty response');
  if (expectedSize !== undefined && bytes.length !== expectedSize) {
    throw new Error(`expected ${expectedSize} bytes but got ${bytes.length}`);
  }
  await writeToBrowserCache(url, bytes);
  return bytes;
}

async function loadChunkedFont(chunkUrls: string[]): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for (let i = 0; i < chunkUrls.length; i += 1) {
    notifyFontProgress(`Preparing font… (${i + 1}/${chunkUrls.length})`);
    try {
      parts.push(await fetchChunkBytes(chunkUrls[i], i, chunkUrls.length));
    } catch (err) {
      throw new Error(`font part ${i + 1}/${chunkUrls.length}: ${(err as Error)?.message || err}`);
    }
  }
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  if (chunkUrls.length === 8 && total !== EXPECTED_TOTAL_FONT_SIZE) {
    throw new Error(`assembled font size mismatch: expected ${EXPECTED_TOTAL_FONT_SIZE} bytes, got ${total}`);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  assertUsableTrueType(bytes);
  return bytes;
}

let inflightDefaultLoad: Promise<string> | null = null;

export async function loadCjkFontBase64(urls?: string[]): Promise<string> {
  if (cachedFontBase64) return cachedFontBase64;
  // Default call (no explicit URLs): share one load between the background prefetch and the export click.
  if (!urls) {
    if (!inflightDefaultLoad) {
      inflightDefaultLoad = loadCjkFontBase64Uncached(undefined).finally(() => {
        inflightDefaultLoad = null;
      });
    }
    return inflightDefaultLoad;
  }
  return loadCjkFontBase64Uncached(urls);
}

async function loadCjkFontBase64Uncached(urls?: string[]): Promise<string> {
  const attempts: string[] = [];
  if (!urls) {
    const chunkUrls = bundledFontChunkUrls();
    if (chunkUrls.length > 0) {
      try {
        const assembled = await loadChunkedFont(chunkUrls);
        cachedFontBase64 = toBase64(assembled);
        notifyFontProgress(null);
        return cachedFontBase64;
      } catch (err) {
        attempts.push(`${(err as Error)?.message || err}`);
      }
    }
  }
  for (const url of distinctUrls(urls ?? getCjkFontUrls())) {
    notifyFontProgress('Preparing font…');
    try {
      const bytes = await fetchFontBytes(url);
      assertUsableTrueType(bytes);
      cachedFontBase64 = toBase64(bytes);
      notifyFontProgress(null);
      return cachedFontBase64;
    } catch (err) {
      attempts.push(`${url}: ${(err as Error)?.message || err}`);
    }
  }
  notifyFontProgress(null);
  throw new CjkFontUnavailableError(attempts);
}

/** Warms the font in the background (memory + Cache Storage) so the export click does not have to download it. Never throws. */
export async function prefetchCjkFont(): Promise<void> {
  if (cachedFontBase64) return;
  try {
    await loadCjkFontBase64();
  } catch (err) {
    console.warn('CJK font prefetch did not complete; the export will retry:', err);
  }
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
