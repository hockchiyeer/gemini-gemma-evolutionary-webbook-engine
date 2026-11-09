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

// --- Progress reporting -------------------------------------------------------------------------------------------------------------
// The export UI registers one listener (App.tsx) and shows the latest status line ("Preparing font… (3/8)", retry pauses, ...).
// A message sent while nobody listens (background prefetch) is replayed to the next listener.
export type FontProgressCallback = (status: string | null) => void;
let fontProgressListener: FontProgressCallback | null = null;
let lastProgressMessage: string | null = null;

export function setFontProgressListener(listener: FontProgressCallback | null): void {
  fontProgressListener = listener;
  if (listener && lastProgressMessage) {
    listener(lastProgressMessage);
  }
}

/** Sends a status line to the export UI; null clears it. Also used by exportService ("Generating PDF…"). Never throws. */
export function reportExportStatus(message: string | null): void {
  lastProgressMessage = message;
  if (fontProgressListener) {
    try {
      fontProgressListener(message);
    } catch {
      /* a failing UI callback must never break the export */
    }
  }
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const FONT_CACHE_NAME = 'webbook-cjk-font-v2';
const LEGACY_FONT_CACHE_NAMES = ['webbook-cjk-font-v1'];
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
    if (onRetry) onRetry(attempt, maxAttempts, waitMs);
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

/** Frees the Cache Storage entries of earlier versions of this loader (each held a full copy of the font). Best effort. */
async function purgeLegacyFontCaches(): Promise<void> {
  try {
    if (typeof caches === 'undefined') return;
    for (const name of LEGACY_FONT_CACHE_NAMES) await caches.delete(name);
  } catch {
    /* ignore */
  }
}

async function readLocalFile(url: string): Promise<Uint8Array> {
  // Node (server-side tests / scripts): fetch() cannot read file: URLs.
  const fsModule = 'node:fs/promises';
  const urlModule = 'node:url';
  const { readFile } = await import(/* @vite-ignore */ fsModule);
  const { fileURLToPath } = await import(/* @vite-ignore */ urlModule);
  return new Uint8Array(await readFile(fileURLToPath(url)));
}

async function fetchFontBytes(url: string): Promise<Uint8Array> {
  if (url.startsWith('file:')) return readLocalFile(url);
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
    reportExportStatus(`Preparing font… retrying in ${Math.round(waitMs / 1000)}s`);
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

// --- Font delivered as verified pieces ----------------------------------------------------------------------------------------------
// The font is also shipped as ~1 MB pieces (src/assets/fonts/chunks) described by chunks/manifest.json (sizes and SHA-256 of every piece).
// The hosted AI Studio preview answers a single 7 MB download with "429 Too Many Requests"; small sequential requests that are cached one by
// one let a later attempt (or the background prefetch) fetch only what is still missing. The manifest is written by
// scripts/split-cjk-font.mjs, so replacing the font never requires editing sizes in this file.

export interface FontChunkSpec {
  url: string;
  size: number;
  sha256?: string;
}

export interface FontManifest {
  file?: string;
  totalSize: number;
  sha256?: string;
  chunks: Array<{ name: string; size: number; sha256?: string }>;
}

export function isFontManifest(value: unknown): value is FontManifest {
  const manifest = value as FontManifest | null;
  if (!manifest || typeof manifest !== 'object') return false;
  if (!Number.isInteger(manifest.totalSize) || manifest.totalSize <= 0) return false;
  if (!Array.isArray(manifest.chunks) || manifest.chunks.length === 0) return false;
  let sum = 0;
  for (const chunk of manifest.chunks) {
    if (!chunk || typeof chunk.name !== 'string' || !chunk.name) return false;
    if (!Number.isInteger(chunk.size) || chunk.size <= 0) return false;
    if (chunk.sha256 !== undefined && !/^[0-9a-f]{64}$/i.test(chunk.sha256)) return false;
    sum += chunk.size;
  }
  return sum === manifest.totalSize;
}

/** Pairs every manifest entry with its URL; null when a piece has no URL (an incomplete deployment must not be half-used). */
export function buildChunkSpecs(manifest: FontManifest, urlFor: (name: string) => string | undefined): FontChunkSpec[] | null {
  const specs: FontChunkSpec[] = [];
  for (const chunk of manifest.chunks) {
    const url = urlFor(chunk.name);
    if (!url) return null;
    specs.push({ url, size: chunk.size, sha256: chunk.sha256 });
  }
  return specs;
}

function bundledChunkSpecs(): FontChunkSpec[] {
  try {
    const manifests = import.meta.glob('../assets/fonts/chunks/manifest.json', { import: 'default', eager: true }) as Record<string, unknown>;
    const manifest = Object.values(manifests)[0];
    if (!isFontManifest(manifest)) return [];
    const urls = import.meta.glob('../assets/fonts/chunks/*.bin', { query: '?url', import: 'default', eager: true }) as Record<string, unknown>;
    const byName = new Map<string, string>();
    for (const [key, url] of Object.entries(urls)) {
      if (typeof url === 'string' && url.length > 0) byName.set(key.split('/').pop() as string, url);
    }
    return buildChunkSpecs(manifest, (name) => byName.get(name)) ?? [];
  } catch {
    return [];
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string | null> {
  try {
    const subtle = (globalThis as any).crypto?.subtle;
    if (!subtle) return null; // insecure context: the size check still applies
    const digest = new Uint8Array(await subtle.digest('SHA-256', bytes));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

/** Null when the piece is exactly what the manifest says; otherwise a short description of the problem. */
async function describeChunkProblem(bytes: Uint8Array, spec: FontChunkSpec): Promise<string | null> {
  if (bytes.length !== spec.size) return `size mismatch: expected ${spec.size} bytes but got ${bytes.length}`;
  if (spec.sha256) {
    const actual = await sha256Hex(bytes);
    if (actual !== null && actual !== spec.sha256.toLowerCase()) return 'checksum mismatch';
  }
  return null;
}

async function fetchChunkBytes(spec: FontChunkSpec): Promise<Uint8Array> {
  if (spec.url.startsWith('file:')) {
    const bytes = await readLocalFile(spec.url);
    const problem = await describeChunkProblem(bytes, spec);
    if (problem) throw new Error(problem);
    return bytes;
  }
  const cached = await readFromBrowserCache(spec.url);
  if (cached && (await describeChunkProblem(cached, spec)) === null) return cached;
  let problem: string | null = null;
  // A truncated or wrong body (proxy error page, cut connection) gets one more download before the piece is given up on.
  for (let download = 1; download <= 2; download += 1) {
    const response = await fetchWithRetry(spec.url, 8, 15000, (_attempt, _max, waitMs) => {
      reportExportStatus(`Preparing font… retrying in ${Math.round(waitMs / 1000)}s`);
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    problem = await describeChunkProblem(bytes, spec);
    if (problem === null) {
      await writeToBrowserCache(spec.url, bytes);
      return bytes;
    }
  }
  throw new Error(problem as string);
}

export async function loadChunkedFont(chunks: FontChunkSpec[]): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for (let i = 0; i < chunks.length; i += 1) {
    reportExportStatus(`Preparing font… (${i + 1}/${chunks.length})`);
    try {
      parts.push(await fetchChunkBytes(chunks[i]));
    } catch (err) {
      throw new Error(`font part ${i + 1}/${chunks.length}: ${(err as Error)?.message || err}`);
    }
  }
  const total = parts.reduce((sum, part) => sum + part.length, 0);
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

async function encodeFont(bytes: Uint8Array): Promise<string> {
  // The base64 conversion of 7.6 MB takes a moment on the main thread; let the status line paint first.
  reportExportStatus('Preparing font… (encoding)');
  await sleep(30);
  return toBase64(bytes);
}

async function loadCjkFontBase64Uncached(urls?: string[]): Promise<string> {
  const attempts: string[] = [];
  void purgeLegacyFontCaches();
  if (!urls) {
    const chunks = bundledChunkSpecs();
    if (chunks.length > 0) {
      try {
        cachedFontBase64 = await encodeFont(await loadChunkedFont(chunks));
        reportExportStatus(null);
        return cachedFontBase64;
      } catch (err) {
        attempts.push(`${(err as Error)?.message || err}`);
      }
    }
  }
  for (const url of distinctUrls(urls ?? getCjkFontUrls())) {
    reportExportStatus('Preparing font…');
    try {
      const bytes = await fetchFontBytes(url);
      assertUsableTrueType(bytes);
      cachedFontBase64 = await encodeFont(bytes);
      reportExportStatus(null);
      return cachedFontBase64;
    } catch (err) {
      attempts.push(`${url}: ${(err as Error)?.message || err}`);
    }
  }
  reportExportStatus(null);
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
