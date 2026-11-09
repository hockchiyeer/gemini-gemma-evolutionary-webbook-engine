import type { Chapter, Definition, SubTopic, WebBook } from '../types';
import { isSnippetOnlySourceMode } from '../types';
import { getChapterSourceLinks, sanitizeWebBookForPresentation } from '../utils/webBookRender';
import { downloadBlob, getExportFileName } from './exportDocument';
import { getWebBookDocumentTitle, summarizeTitle } from './documentTitle';
import { getExportLabels } from './exportLabels';
import { loadExportLibrary } from './lazyExportLibs';

// ---------------------------------------------------------------------------
// Print-friendly report, "reader mode" edition
// ---------------------------------------------------------------------------
// Design goals (modelled on Edge Immersive Reader / LinkedIn reader view):
//   * one centred column, generous 16px (12pt) text with 1.7 line height, left-aligned (no justification)
//   * a plain system sans-serif stack (no decorative / monospace / italic display faces, no external web fonts)
//   * semantic structure (h1/h2/h3, paragraphs, definition lists, real links) with high-contrast colours
//   * PDF: real vector text produced by the browser's own print engine (crisp at any zoom / printer dpi,
//     selectable, searchable, screen-reader friendly) instead of a screenshot of the page
//   * JPG: one A4 image per page rendered at 3x (~288 dpi) instead of one tall image squeezed into a
//     16-megapixel canvas

function escapeHtml(text: string): string {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// The chapter sections below carry the complete text, so the brief deliberately does not repeat chapter 1. The engine's
// generation note is an English diagnostic ("Selected Gemini model … unavailable …"): it is shown as is only in an English
// book. Any other book gets a sentence in its own language, built from the offline compilation figures when there are any.
export function getExecutiveOverview(webBook: WebBook): string {
  const labels = getExportLabels(webBook);
  const note = webBook.generationNote;
  if (!note) return labels.overviewFallback(webBook.topic);
  if (labels.locale === 'en') return note;
  const stats = note.match(/Compiled offline from (\d+) sources? \((\d+) sentences?, (\d+) words?\)/);
  return stats
    ? labels.offlineOverview(webBook.topic, Number(stats[1]), Number(stats[2]), Number(stats[3]))
    : labels.overviewFallback(webBook.topic);
}

// ---------------------------------------------------------------------------
// Geometry (CSS px @ 96dpi)
// ---------------------------------------------------------------------------

const PAGE_WIDTH_PX = 794; // A4
const PAGE_HEIGHT_PX = 1123;
const IMAGE_PAGE_PADDING_TOP_PX = 64;
const IMAGE_PAGE_PADDING_X_PX = 72;
const IMAGE_PAGE_FOOTER_RESERVE_PX = 72;
const IMAGE_CONTENT_WIDTH_PX = PAGE_WIDTH_PX - IMAGE_PAGE_PADDING_X_PX * 2; // 650px => ~75 characters per line
const IMAGE_CONTENT_HEIGHT_PX = PAGE_HEIGHT_PX - IMAGE_PAGE_PADDING_TOP_PX - IMAGE_PAGE_FOOTER_RESERVE_PX;
const PAGE_FIT_SAFETY_PX = 2;
// 3x of 794x1123 css px = 2382x3369 px, i.e. ~288 dpi on A4: sharp when printed, ~8 MP per page (safe for browsers)
const IMAGE_RENDER_SCALE = 3;
const JPEG_QUALITY = 0.95;

const BODY_FONT_PX = 16;
const BODY_LINE_PX = BODY_FONT_PX * 1.7;
const MAX_PARAGRAPH_CHARS = 1800; // image pages only: keeps blocks small so pages fill evenly
const LATIN_CHAR_EM = 0.56; // average advance of the sans stack in em (slightly pessimistic)
const WIDE_CHAR = /[\u1100-\u11ff\u2e80-\ua4cf\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/;

// ---------------------------------------------------------------------------
// Typography shared by the PDF (print) document and the JPG pages
// ---------------------------------------------------------------------------

const READER_FONT_STACK = [
  '"Segoe UI"',
  '"Helvetica Neue"',
  'Arial',
  '"Noto Sans"',
  '"Noto Sans CJK SC"',
  '"Noto Sans CJK TC"',
  '"Noto Sans CJK JP"',
  '"Noto Sans CJK KR"',
  '"PingFang SC"',
  '"Microsoft YaHei"',
  '"Microsoft JhengHei"',
  '"Hiragino Sans"',
  '"Malgun Gothic"',
  'system-ui',
  'sans-serif',
].join(', ');

const READER_CSS = `
.pf-doc { font-family: ${READER_FONT_STACK}; font-size: ${BODY_FONT_PX}px; line-height: 1.7; color: #1f1f1f; text-align: left; overflow-wrap: break-word; font-kerning: normal; text-rendering: optimizeLegibility; -webkit-font-smoothing: antialiased; }
.pf-doc, .pf-doc * { box-sizing: border-box; }
.pf-doc p { margin: 0 0 1em 0; white-space: pre-line; }
.pf-doc a { color: #0a4aa6; text-decoration: underline; }
.pf-kicker { font-size: 13px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #595959; margin: 0 0 0.75em 0; }
.pf-doc h1 { font-size: 34px; line-height: 1.2; font-weight: 700; color: #111111; margin: 0 0 0.5em 0; }
.pf-doc p.pf-meta { font-size: 14px; line-height: 1.5; color: #595959; margin: 0 0 1.25em 0; }
.pf-abstract { border-left: 4px solid #8c8c8c; padding: 2px 0 2px 16px; margin: 0 0 0.5em 0; }
.pf-doc p.pf-label { font-size: 13px; line-height: 1.4; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: #444444; margin: 0 0 0.25em 0; }
.pf-abstract p:last-child { margin-bottom: 0; }
.pf-doc h2 { font-size: 24px; line-height: 1.3; font-weight: 700; color: #111111; margin: 1.6em 0 0.6em 0; }
.pf-doc h3 { font-size: 18px; line-height: 1.35; font-weight: 700; color: #111111; margin: 1.2em 0 0.5em 0; }
.pf-doc dl.pf-item { margin: 0 0 0.9em 0; }
.pf-doc dl.pf-item dt { font-weight: 700; color: #111111; }
.pf-doc dl.pf-item dd { margin: 0; }
.pf-doc p.pf-sources { font-size: 14px; line-height: 1.6; color: #444444; margin: 0.5em 0 0 0; padding-top: 0.75em; border-top: 1px solid #cfcfcf; }
.pf-doc div.pf-note { margin: 2em 0 0 0; padding-top: 0.75em; border-top: 2px solid #1f1f1f; }
.pf-doc div.pf-note p { font-size: 14px; line-height: 1.6; color: #444444; margin: 0; }
.pf-doc div.pf-note p.pf-label { margin-bottom: 0.25em; }
.pf-blk { display: flow-root; }
.pf-page .pf-blk:first-child > *:first-child { margin-top: 0; }
`;

// ---------------------------------------------------------------------------
// Content blocks
// ---------------------------------------------------------------------------

interface ReportBlock {
  html: string;
  /** Estimated rendered height in px at IMAGE_CONTENT_WIDTH_PX (replaced by real measurements in a browser). */
  height: number;
  /** Keep this block on the same page as the next one (headings must not be stranded at the bottom of a page). */
  keepWithNext: boolean;
}

// Slightly pessimistic width model (Latin ~0.56em, CJK 1em per character).
function estimateLines(text: string, fontPx: number, widthPx: number): number {
  let lines = 0;
  for (const segment of text.split('\n')) {
    if (!segment) {
      lines += 1;
      continue;
    }
    let em = 0;
    for (const char of segment) {
      em += WIDE_CHAR.test(char) ? 1 : LATIN_CHAR_EM;
    }
    const segmentWidth = em * fontPx;
    lines += Math.max(1, Math.ceil(segmentWidth / widthPx));
  }
  return Math.max(1, lines);
}

function splitLongParagraph(paragraph: string): string[] {
  if (paragraph.length <= MAX_PARAGRAPH_CHARS) {
    return [paragraph];
  }
  const sentences = paragraph.split(/(?<=[.!?。！？])\s+/);
  const pieces: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    if (current && current.length + sentence.length + 1 > MAX_PARAGRAPH_CHARS) {
      pieces.push(current.trim());
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current) {
    pieces.push(current.trim());
  }
  return pieces;
}

function splitIntoParagraphs(content: string, splitLong: boolean): string[] {
  const paragraphs = (content || '')
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  return splitLong ? paragraphs.flatMap(splitLongParagraph) : paragraphs;
}

function paragraphBlock(text: string): ReportBlock {
  return {
    html: `<p>${escapeHtml(text)}</p>`,
    height: estimateLines(text, BODY_FONT_PX, IMAGE_CONTENT_WIDTH_PX) * BODY_LINE_PX + BODY_FONT_PX,
    keepWithNext: false,
  };
}

function headingBlock(level: 2 | 3, text: string): ReportBlock {
  const fontPx = level === 2 ? 24 : 18;
  const lineHeight = level === 2 ? 1.3 : 1.35;
  const marginTop = level === 2 ? 1.6 : 1.2;
  const marginBottom = level === 2 ? 0.6 : 0.5;
  return {
    html: `<h${level}>${escapeHtml(text)}</h${level}>`,
    height: estimateLines(text, fontPx, IMAGE_CONTENT_WIDTH_PX) * fontPx * lineHeight + fontPx * (marginTop + marginBottom),
    keepWithNext: true,
  };
}

function itemBlock(label: string, text: string): ReportBlock {
  return {
    html: `<dl class="pf-item"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(text)}</dd></dl>`,
    height:
      (estimateLines(label, BODY_FONT_PX, IMAGE_CONTENT_WIDTH_PX) + estimateLines(text, BODY_FONT_PX, IMAGE_CONTENT_WIDTH_PX)) *
        BODY_LINE_PX +
      BODY_FONT_PX * 0.9,
    keepWithNext: false,
  };
}

function sourcesBlock(chapter: Chapter, L: ReturnType<typeof getExportLabels>): ReportBlock | null {
  const links = getChapterSourceLinks(chapter);
  if (links.length === 0) return null;

  const labels = links.map((link) => link.hostname || link.title);
  const anchors = links.map((link, index) => `<a href="${escapeHtml(link.url)}">${escapeHtml(labels[index])}</a>`).join(', ');
  const labelText = `${L.sources}${L.colon}${labels.join(', ')}`;
  return {
    html: `<p class="pf-sources"><strong>${escapeHtml(L.sources)}${escapeHtml(L.colon.trim())}</strong> ${anchors}</p>`,
    height: estimateLines(labelText, 14, IMAGE_CONTENT_WIDTH_PX) * 14 * 1.6 + 14 * 1.25 + 8,
    keepWithNext: false,
  };
}

function formatChapterHeading(title: string, index: number): string {
  const trimmed = title.trim();
  const match = trimmed.match(/^(\d+)\.\s*(.*)$/);
  if (match) {
    return `${index + 1}. ${match[2]}`;
  }
  return `${index + 1}. ${trimmed}`;
}

function getChapterBlocks(chapter: Chapter, chapterIndex: number, splitLongParagraphs: boolean, L: ReturnType<typeof getExportLabels>): ReportBlock[] {
  const headingText = formatChapterHeading(chapter.title, chapterIndex);
  const blocks: ReportBlock[] = [headingBlock(2, headingText)];

  splitIntoParagraphs(chapter.content, splitLongParagraphs).forEach((paragraph) => blocks.push(paragraphBlock(paragraph)));

  const concepts = (chapter.definitions || []).map((d: Definition) => ({ label: d.term, text: d.description }));
  if (concepts.length > 0) {
    blocks.push(headingBlock(3, L.coreConcepts));
    concepts.forEach((item) => blocks.push(itemBlock(item.label, item.text)));
  }

  const dimensions = (chapter.subTopics || []).map((s: SubTopic) => ({ label: s.title, text: s.summary }));
  if (dimensions.length > 0) {
    blocks.push(headingBlock(3, L.keyDimensions));
    dimensions.forEach((item) => blocks.push(itemBlock(item.label, item.text)));
  }

  const sources = sourcesBlock(chapter, L);
  if (sources) {
    // A sources line must never be stranded alone at the top of a page: tie it to the block before it.
    blocks[blocks.length - 1].keepWithNext = true;
    blocks.push(sources);
  }
  return blocks;
}

function getHeaderBlock(webBook: WebBook): ReportBlock {
  const chapters = webBook.chapters || [];
  const totalConcepts = chapters.reduce((acc, ch) => acc + (Array.isArray(ch.definitions) ? ch.definitions.length : 0), 0);
  const L = getExportLabels(webBook);
  const dateStr = new Date(webBook.timestamp).toLocaleDateString(L.dateLocale, { year: 'numeric', month: 'short', day: 'numeric' });
  const mode = isSnippetOnlySourceMode(webBook.sourceMode)
    ? L.fallbackSearch
    : webBook.sourceMode === 'model_knowledge'
      ? L.modelKnowledge
      : L.groundedAi;
  const meta = [
    L.chapterCount(chapters.length),
    L.conceptCount(totalConcepts),
    dateStr,
    mode,
  ].join(' · ');
  const overview = getExecutiveOverview(webBook);

  return {
    html:
      `<p class="pf-kicker">${escapeHtml(L.engineName)}</p>` +
      `<h1>${escapeHtml(webBook.topic)}</h1>` +
      `<p class="pf-meta">${escapeHtml(meta)}</p>` +
      `<div class="pf-abstract"><p class="pf-label">${escapeHtml(L.abstract)}</p><p>${escapeHtml(overview)}</p></div>`,
    height:
      40 +
      estimateLines(webBook.topic, 34, IMAGE_CONTENT_WIDTH_PX) * 34 * 1.2 +
      60 +
      estimateLines(overview, BODY_FONT_PX, IMAGE_CONTENT_WIDTH_PX - 20) * BODY_LINE_PX +
      40,
    keepWithNext: false,
  };
}

function getConclusionBlock(L: ReturnType<typeof getExportLabels>): ReportBlock {
  return {
    html: `<div class="pf-note"><p class="pf-label">${escapeHtml(L.evidenceSynthesisTitle)}</p><p>${escapeHtml(L.conclusionText)}</p></div>`,
    height: 60 + estimateLines(L.conclusionText, 14, IMAGE_CONTENT_WIDTH_PX) * 14 * 1.6,
    keepWithNext: false,
  };
}

function buildReportBlocks(webBook: WebBook, splitLongParagraphs: boolean): ReportBlock[] {
  const chapters = webBook.chapters || [];
  const L = getExportLabels(webBook);
  return [
    getHeaderBlock(webBook),
    ...chapters.flatMap((chapter, index) => getChapterBlocks(chapter, index, splitLongParagraphs, L)),
    getConclusionBlock(L),
  ];
}

// ---------------------------------------------------------------------------
// PDF: one flowing reader-mode document, paginated natively by the browser (vector text)
// ---------------------------------------------------------------------------

function detectLanguage(text: string): string {
  if (/[\u3040-\u30ff]/.test(text)) return 'ja';
  if (/[\uac00-\ud7af]/.test(text)) return 'ko';
  if (/[\u4e00-\u9fff]/.test(text)) return 'zh';
  return 'en';
}

const PRINT_DOCUMENT_CSS = `
html { background: #ffffff; }
body { margin: 0; background: #ffffff; }
.pf-cover-page {
  background: #141414;
  color: #E4E3E0;
  padding: 80px 48px;
  box-sizing: border-box;
  text-align: center;
  position: relative;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  min-height: 100vh;
  break-after: page;
  page-break-after: always;
}
.pf-cover-emblem { display: flex; flex-direction: column; align-items: center; margin-bottom: 24px; }
.pf-diamond { width: 44px; height: 44px; border: 1.5px solid #E4E3E0; transform: rotate(45deg); display: flex; align-items: center; justify-content: center; margin-bottom: 16px; }
.pf-diamond svg { transform: rotate(-45deg); }
.pf-cover-engine { font-size: 12px; font-weight: 600; letter-spacing: 0.35em; text-transform: uppercase; color: #a0a0a0; }
.pf-cover-title { font-family: Georgia, serif; font-weight: 700; font-size: 38px; line-height: 1.25; color: #ffffff; margin: 0 0 24px 0; max-width: 90%; word-break: break-word; }
.pf-cover-divider { width: 60px; height: 2px; background: rgba(228, 227, 224, 0.4); margin: 0 auto 32px; }
.pf-cover-stats { display: flex; justify-content: center; gap: 48px; text-align: center; }
.pf-stat-col { display: flex; flex-direction: column; align-items: center; }
.pf-stat-label { font-size: 12px; text-transform: uppercase; letter-spacing: 0.15em; color: #888888; margin-bottom: 6px; }
.pf-stat-val { font-size: 24px; font-weight: 700; color: #ffffff; }
.pf-cover-circle-1 { position: absolute; top: -100px; left: -100px; width: 400px; height: 400px; border: 1px solid rgba(255,255,255,0.06); border-radius: 50%; pointer-events: none; }
.pf-cover-circle-2 { position: absolute; bottom: -120px; right: -120px; width: 480px; height: 480px; border: 1px solid rgba(255,255,255,0.06); border-radius: 50%; pointer-events: none; }

.pf-toc-page {
  background: #ffffff;
  padding: 64px 48px;
  box-sizing: border-box;
  min-height: 100vh;
  break-after: page;
  page-break-after: always;
}
.pf-toc-title { font-size: 28px; font-weight: 800; color: #111111; margin: 0 0 12px 0; letter-spacing: -0.02em; }
.pf-toc-line { width: 80px; height: 3px; background: #111111; margin-bottom: 40px; }
.pf-toc-item { display: flex; align-items: baseline; gap: 16px; margin-bottom: 20px; font-size: 16px; line-height: 1.5; }
.pf-toc-num { font-weight: 700; color: #8c8c8c; font-family: monospace, sans-serif; font-size: 15px; shrink: 0; min-width: 28px; }
.pf-toc-item-title { font-weight: 700; color: #111111; max-width: 80%; word-break: break-word; }
.pf-toc-dots { flex: 1; border-bottom: 1px dotted #d0d0d0; margin-bottom: 4px; }

.pf-article { max-width: 40em; margin: 0 auto; padding: 48px 24px 72px; }
@page {
  size: A4;
  margin: 20mm 22mm 22mm 22mm;
  @bottom-center { content: counter(page) " / " counter(pages); font-family: ${READER_FONT_STACK}; font-size: 12px; color: #595959; }
}
@media print {
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .pf-cover-page { break-after: page; page-break-after: always; min-height: 100vh; max-height: 100vh; box-sizing: border-box; margin: 0; }
  .pf-toc-page { break-after: page; page-break-after: always; min-height: 100vh; max-height: 100vh; box-sizing: border-box; margin: 0; }
  .pf-article { max-width: none; margin: 0; padding: 0; }
  .pf-doc h1, .pf-doc h2, .pf-doc h3, .pf-label { break-after: avoid; page-break-after: avoid; }
  .pf-doc p { orphans: 3; widows: 3; }
  .pf-doc dl.pf-item, .pf-doc p.pf-sources, .pf-abstract, .pf-note { break-inside: avoid; page-break-inside: avoid; }
}
`;

/** Complete, standalone reader-mode HTML document for the print-friendly report. Pages are created by the browser. */
export function buildPrintFriendlyReportHtml(webBook: WebBook): string {
  const safeWebBook = sanitizeWebBookForPresentation(webBook);
  const title = getWebBookDocumentTitle(safeWebBook.topic);
  const L = getExportLabels(safeWebBook);
  const chapters = safeWebBook.chapters || [];
  const totalConcepts = chapters.reduce((acc, ch) => acc + (Array.isArray(ch.definitions) ? ch.definitions.length : 0), 0);
  const dateStr = new Date(safeWebBook.timestamp).toLocaleDateString(L.dateLocale, { year: 'numeric', month: 'short' });

  const coverHtml = `
<div class="pf-cover-page">
  <div class="pf-cover-circle-1"></div>
  <div class="pf-cover-circle-2"></div>
  <div class="pf-cover-emblem">
    <div class="pf-diamond">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#E4E3E0" stroke-width="1.5">
        <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
      </svg>
    </div>
    <div class="pf-cover-engine">${escapeHtml(L.engineName)}</div>
  </div>
  <h1 class="pf-cover-title">${escapeHtml(summarizeTitle(safeWebBook.topic))}</h1>
  <div class="pf-cover-divider"></div>
  <div class="pf-cover-stats">
    <div class="pf-stat-col">
      <span class="pf-stat-label">${escapeHtml(L.chapters)}</span>
      <span class="pf-stat-val">${chapters.length}</span>
    </div>
    <div class="pf-stat-col">
      <span class="pf-stat-label">${escapeHtml(L.concepts)}</span>
      <span class="pf-stat-val">${totalConcepts}</span>
    </div>
    <div class="pf-stat-col">
      <span class="pf-stat-label">${escapeHtml(L.date)}</span>
      <span class="pf-stat-val">${escapeHtml(dateStr)}</span>
    </div>
  </div>
</div>`;

  const tocItems = chapters.map((ch, idx) => `
    <div class="pf-toc-item">
      <span class="pf-toc-num">${String(idx + 1).padStart(2, '0')}</span>
      <span class="pf-toc-item-title">${escapeHtml(ch.title)}</span>
      <span class="pf-toc-dots"></span>
    </div>
  `).join('');

  const tocHtml = `
<div class="pf-toc-page">
  <div class="pf-toc-header">
    <div class="pf-toc-title">${escapeHtml(L.tableOfContents)}</div>
    <div class="pf-toc-line"></div>
  </div>
  <div class="pf-toc-list">
    ${tocItems}
  </div>
</div>`;

  const body = buildReportBlocks(safeWebBook, false)
    .map((block) => block.html)
    .join('\n');

  return `<!doctype html>
<html lang="${detectLanguage(safeWebBook.topic)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${READER_CSS}${PRINT_DOCUMENT_CSS}</style>
</head>
<body>
${coverHtml}
${tocHtml}
<main class="pf-doc pf-article">
${body}
</main>
</body>
</html>`;
}

function hasPrintableBrowser(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof document !== 'undefined' &&
    typeof document.createElement === 'function' &&
    typeof window.print === 'function'
  );
}

const AUTO_PRINT_SCRIPT = `<script>
(function () {
  var go = function () { setTimeout(function () { window.focus(); window.print(); }, 400); };
  var ready = function () {
    if (document.fonts && document.fonts.ready) { document.fonts.ready.then(go, go); } else { go(); }
  };
  if (document.readyState === 'complete') { ready(); } else { window.addEventListener('load', ready, { once: true }); }
})();
</script>`;

/**
 * Hands the document to the browser's print engine (destination "Save as PDF" gives a vector, selectable-text PDF).
 * A popup is opened synchronously (before any await) so the user gesture is preserved and sandboxed iframes such as
 * Google AI Studio can print; a hidden iframe is the fallback. Resolves to false when nothing could be launched.
 */
function openPrintDialog(html: string, popup: Window | null): boolean {
  if (popup && popup.document) {
    try {
      const withScript = html.includes('</body>') ? html.replace('</body>', `${AUTO_PRINT_SCRIPT}</body>`) : html + AUTO_PRINT_SCRIPT;
      popup.document.open();
      popup.document.write(withScript);
      popup.document.close();
      return true;
    } catch (error) {
      console.warn('Writing to the print window failed, falling back to an iframe:', error);
      try {
        popup.close();
      } catch {}
    }
  }

  try {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.position = 'fixed';
    iframe.style.top = '0';
    iframe.style.left = '0';
    iframe.style.width = '210mm';
    iframe.style.height = '297mm';
    iframe.style.border = '0';
    iframe.style.opacity = '0';
    iframe.style.pointerEvents = 'none';
    document.body.appendChild(iframe);

    const frameWindow = iframe.contentWindow;
    const frameDocument = frameWindow?.document;
    if (!frameWindow || !frameDocument) {
      iframe.parentNode?.removeChild(iframe);
      return false;
    }

    let finished = false;
    const cleanup = () => {
      if (finished) return;
      finished = true;
      setTimeout(() => iframe.parentNode?.removeChild(iframe), 300);
    };
    frameDocument.open();
    frameDocument.write(html);
    frameDocument.close();
    frameWindow.addEventListener('afterprint', cleanup, { once: true });

    const run = () => {
      try {
        frameWindow.focus();
        frameWindow.print();
      } catch (error) {
        console.warn('Iframe print failed:', error);
        cleanup();
      }
    };
    setTimeout(() => {
      const fonts = frameDocument.fonts;
      if (fonts?.ready) {
        fonts.ready.then(run, run);
      } else {
        run();
      }
    }, 300);
    return true;
  } catch (error) {
    console.warn('Could not start the print dialog:', error);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Image pages (JPG, and the raster PDF fallback)
// ---------------------------------------------------------------------------

/**
 * Greedy page packing of blocks with known heights. A block flagged keepWithNext moves to the next page together
 * with the block that follows it (a heading is never left alone at the bottom of a page). A block taller than a
 * page is placed on a page of its own rather than being dropped.
 */
export function paginateBlockHeights(heights: number[], keepWithNext: boolean[], capacity: number): number[][] {
  const pages: number[][] = [[]];
  let used = 0;
  let index = 0;

  while (index < heights.length) {
    const group = [index];
    while (keepWithNext[group[group.length - 1]] && group[group.length - 1] + 1 < heights.length && group.length < 3) {
      group.push(group[group.length - 1] + 1);
    }
    const groupHeight = group.reduce((sum, i) => sum + heights[i], 0);

    if (pages[pages.length - 1].length > 0 && used + groupHeight > capacity) {
      pages.push([]);
      used = 0;
    }
    pages[pages.length - 1].push(...group);
    used += groupHeight;
    index += group.length;
  }
  return pages;
}

function renderImagePageHtml(blocks: ReportBlock[], blockIndexes: number[], title: string, pageLabel: string): string {
  const body = blockIndexes.map((i) => `<div class="pf-blk">${blocks[i].html}</div>`).join('');
  return `<div class="pf-page" style="position: relative; width: ${PAGE_WIDTH_PX}px; height: ${PAGE_HEIGHT_PX}px; box-sizing: border-box; padding: ${IMAGE_PAGE_PADDING_TOP_PX}px ${IMAGE_PAGE_PADDING_X_PX}px 0 ${IMAGE_PAGE_PADDING_X_PX}px; background: #ffffff; overflow: hidden;">
  <div class="pf-doc" style="width: ${IMAGE_CONTENT_WIDTH_PX}px; height: ${IMAGE_CONTENT_HEIGHT_PX}px; overflow: hidden;">${body}</div>
  <div class="pf-doc" style="position: absolute; left: ${IMAGE_PAGE_PADDING_X_PX}px; right: ${IMAGE_PAGE_PADDING_X_PX}px; bottom: 28px; display: flex; justify-content: space-between; gap: 16px; border-top: 1px solid #cfcfcf; padding-top: 8px; font-size: 12px; line-height: 1.4; color: #595959;">
    <span>${escapeHtml(title)}</span>
    <span style="white-space: nowrap; font-weight: 700; color: #1f1f1f;">${escapeHtml(pageLabel)}</span>
  </div>
</div>`;
}

function renderImageCoverPageHtml(webBook: WebBook, L: ReturnType<typeof getExportLabels>, totalPages: number): string {
  const chapters = webBook.chapters || [];
  const totalConcepts = chapters.reduce((acc, ch) => acc + (Array.isArray(ch.definitions) ? ch.definitions.length : 0), 0);
  const dateStr = new Date(webBook.timestamp).toLocaleDateString(L.dateLocale, { year: 'numeric', month: 'short' });

  return `<div class="pf-page" style="position: relative; width: ${PAGE_WIDTH_PX}px; height: ${PAGE_HEIGHT_PX}px; box-sizing: border-box; padding: 80px 56px; background: #141414; color: #E4E3E0; overflow: hidden; display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center;">
  <div style="position: absolute; top: -100px; left: -100px; width: 400px; height: 400px; border: 1px solid rgba(255,255,255,0.06); border-radius: 50%; pointer-events: none;"></div>
  <div style="position: absolute; bottom: -120px; right: -120px; width: 480px; height: 480px; border: 1px solid rgba(255,255,255,0.06); border-radius: 50%; pointer-events: none;"></div>
  
  <div style="position: relative; z-index: 10; display: flex; flex-direction: column; align-items: center; width: 100%;">
    <div style="width: 44px; height: 44px; border: 1.5px solid #E4E3E0; transform: rotate(45deg); display: flex; align-items: center; justify-content: center; margin-bottom: 20px;">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#E4E3E0" stroke-width="1.5" style="transform: rotate(-45deg);">
        <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
      </svg>
    </div>
    <div style="font-size: 12px; font-weight: 600; letter-spacing: 0.35em; text-transform: uppercase; color: #a0a0a0; margin-bottom: 36px;">${escapeHtml(L.engineName)}</div>
    
    <h1 style="font-family: Georgia, serif; font-weight: 700; font-size: 40px; line-height: 1.25; color: #ffffff; margin: 0 0 32px 0; letter-spacing: -0.02em; word-break: break-word; max-width: 640px;">${escapeHtml(summarizeTitle(webBook.topic))}</h1>
    
    <div style="width: 60px; height: 2px; background: rgba(228, 227, 224, 0.4); margin: 0 auto 40px;"></div>
    
    <div style="display: flex; justify-content: center; gap: 56px; text-align: center;">
      <div>
        <div style="font-size: 12px; text-transform: uppercase; letter-spacing: 0.15em; color: #888888; margin-bottom: 8px;">${escapeHtml(L.chapters)}</div>
        <div style="font-family: monospace, sans-serif; font-size: 30px; font-weight: 700; color: #ffffff;">${chapters.length}</div>
      </div>
      <div>
        <div style="font-size: 12px; text-transform: uppercase; letter-spacing: 0.15em; color: #888888; margin-bottom: 8px;">${escapeHtml(L.concepts)}</div>
        <div style="font-family: monospace, sans-serif; font-size: 30px; font-weight: 700; color: #ffffff;">${totalConcepts}</div>
      </div>
      <div>
        <div style="font-size: 12px; text-transform: uppercase; letter-spacing: 0.15em; color: #888888; margin-bottom: 8px;">${escapeHtml(L.date)}</div>
        <div style="font-family: sans-serif; font-size: 22px; font-weight: 700; color: #ffffff; padding-top: 6px;">${escapeHtml(dateStr)}</div>
      </div>
    </div>
  </div>

  <div class="pf-doc" style="position: absolute; left: ${IMAGE_PAGE_PADDING_X_PX}px; right: ${IMAGE_PAGE_PADDING_X_PX}px; bottom: 28px; display: flex; justify-content: space-between; gap: 16px; border-top: 1px solid rgba(255,255,255,0.15); padding-top: 8px; font-size: 12px; line-height: 1.4; color: #a0a0a0;">
    <span>${escapeHtml(L.engineName)}</span>
    <span style="white-space: nowrap; font-weight: 700; color: #ffffff;">${escapeHtml(L.pageOf(1, totalPages))}</span>
  </div>
</div>`;
}

function renderImageTocPageHtml(webBook: WebBook, L: ReturnType<typeof getExportLabels>, totalPages: number): string {
  const chapters = webBook.chapters || [];

  const items = chapters.map((ch, idx) => `
    <div style="display: flex; align-items: baseline; gap: 16px; margin-bottom: 22px; font-size: 16px; line-height: 1.5;">
      <span style="font-weight: 700; color: #8c8c8c; font-family: monospace, sans-serif; font-size: 15px; min-width: 28px;">${String(idx + 1).padStart(2, '0')}</span>
      <span style="font-weight: 700; color: #111111; max-width: 80%; word-break: break-word;">${escapeHtml(ch.title)}</span>
      <span style="flex: 1; border-bottom: 1px dotted #d0d0d0; margin-bottom: 4px;"></span>
    </div>
  `).join('');

  return `<div class="pf-page" style="position: relative; width: ${PAGE_WIDTH_PX}px; height: ${PAGE_HEIGHT_PX}px; box-sizing: border-box; padding: 72px 64px; background: #ffffff; overflow: hidden; display: flex; flex-direction: column;">
  <div style="margin-bottom: 40px;">
    <h2 style="font-size: 32px; font-weight: 800; color: #111111; margin: 0 0 12px 0; letter-spacing: -0.02em;">${escapeHtml(L.tableOfContents)}</h2>
    <div style="width: 80px; height: 3px; background: #111111;"></div>
  </div>
  <div style="flex: 1;">
    ${items}
  </div>

  <div class="pf-doc" style="position: absolute; left: ${IMAGE_PAGE_PADDING_X_PX}px; right: ${IMAGE_PAGE_PADDING_X_PX}px; bottom: 28px; display: flex; justify-content: space-between; gap: 16px; border-top: 1px solid #cfcfcf; padding-top: 8px; font-size: 12px; line-height: 1.4; color: #595959;">
    <span>${escapeHtml(L.engineName)}</span>
    <span style="white-space: nowrap; font-weight: 700; color: #1f1f1f;">${escapeHtml(L.pageOf(2, totalPages))}</span>
  </div>
</div>`;
}

/**
 * Builds the HTML of each A4 image page. `measuredHeights` are real block heights from a browser layout; without
 * them (Node, tests) the built-in estimates are used.
 */
export function buildPrintFriendlyReportPagesHtml(webBook: WebBook, measuredHeights?: number[]): string[] {
  const safeWebBook = sanitizeWebBookForPresentation(webBook);
  const blocks = buildReportBlocks(safeWebBook, true);
  const heights = blocks.map((block, i) => measuredHeights?.[i] ?? block.height * 1.05);
  const layout = paginateBlockHeights(
    heights,
    blocks.map((block) => block.keepWithNext),
    IMAGE_CONTENT_HEIGHT_PX - PAGE_FIT_SAFETY_PX
  );
  const L = getExportLabels(safeWebBook);
  const totalPages = 2 + layout.length;

  const pages: string[] = [];
  pages.push(renderImageCoverPageHtml(safeWebBook, L, totalPages));
  pages.push(renderImageTocPageHtml(safeWebBook, L, totalPages));

  layout.forEach((indexes, pageIndex) => {
    pages.push(
      renderImagePageHtml(blocks, indexes, L.engineName, L.pageOf(pageIndex + 3, totalPages))
    );
  });

  return pages;
}

const DUMMY_JPEG_DATA_URL =
  'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

export async function renderPrintFriendlyReportCanvases(webBook: WebBook): Promise<HTMLCanvasElement[]> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return [
      {
        width: PAGE_WIDTH_PX * IMAGE_RENDER_SCALE,
        height: PAGE_HEIGHT_PX * IMAGE_RENDER_SCALE,
        toBlob: (cb: (b: Blob) => void, type?: string) =>
          cb(new Blob(['mock-print-friendly-image'], { type: type || 'image/jpeg' })),
        toDataURL: () => DUMMY_JPEG_DATA_URL,
      } as unknown as HTMLCanvasElement,
    ];
  }

  const html2canvasModule = await loadExportLibrary('html2canvas', () => import('html2canvas'));
  const html2canvas = (html2canvasModule.default || html2canvasModule) as (
    element: HTMLElement,
    options?: Record<string, unknown>
  ) => Promise<HTMLCanvasElement>;

  const safeWebBook = sanitizeWebBookForPresentation(webBook);
  const container = document.createElement('div');
  container.id = 'a4-print-friendly-report-staging';
  container.style.position = 'fixed';
  container.style.top = '0';
  container.style.left = '0';
  container.style.width = `${PAGE_WIDTH_PX}px`;
  container.style.zIndex = '-9999';
  container.style.opacity = '0.01';
  container.style.pointerEvents = 'none';
  container.style.backgroundColor = '#ffffff';
  document.body.appendChild(container);

  const canvases: HTMLCanvasElement[] = [];

  try {
    // 1. Lay all blocks out once at the real column width and measure them, so pages are packed from true heights.
    const blocks = buildReportBlocks(safeWebBook, true);
    container.innerHTML = `<style>${READER_CSS}</style><div class="pf-doc" style="width: ${IMAGE_CONTENT_WIDTH_PX}px;">${blocks
      .map((block) => `<div class="pf-blk">${block.html}</div>`)
      .join('')}</div>`;
    if (document.fonts?.ready) {
      await document.fonts.ready;
    }
    const measureRoot = container.querySelector('.pf-doc') as HTMLElement;
    const measuredHeights = Array.from(measureRoot.children).map((child) => (child as HTMLElement).getBoundingClientRect().height);

    // 2. Render each A4 page at 3x.
    const pagesHtml = buildPrintFriendlyReportPagesHtml(safeWebBook, measuredHeights);
    for (let index = 0; index < pagesHtml.length; index += 1) {
      container.innerHTML = `<style>${READER_CSS}</style>${pagesHtml[index]}`;
      const pageEl = container.querySelector('.pf-page') as HTMLElement;
      const canvas = await html2canvas(pageEl, {
        scale: IMAGE_RENDER_SCALE,
        useCORS: true,
        logging: false,
        backgroundColor: '#ffffff',
        width: PAGE_WIDTH_PX,
        height: PAGE_HEIGHT_PX,
        windowWidth: PAGE_WIDTH_PX,
        windowHeight: PAGE_HEIGHT_PX,
      });
      canvases.push(canvas);
    }
  } finally {
    if (container.parentNode) {
      container.parentNode.removeChild(container);
    }
  }

  return canvases;
}

function canvasToJpgBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error('Failed to generate JPG blob from canvas.'));
        }
      },
      'image/jpeg',
      JPEG_QUALITY
    );
  });
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * JPG export: one sharp A4 image per page (~288 dpi). Single-page reports keep the plain
 * `<topic>_PrintFriendly_Report.jpg` name; longer ones get `_page_01_of_06` style suffixes.
 */
export async function exportPrintFriendlyWebBookToImage(webBook: WebBook): Promise<void> {
  const safeWebBook = sanitizeWebBookForPresentation(webBook);
  const canvases = await renderPrintFriendlyReportCanvases(safeWebBook);
  if (canvases.length === 0) {
    throw new Error('No canvases available to export.');
  }

  const baseName = `${safeWebBook.topic}_PrintFriendly_Report`;
  const pad = (n: number) => String(n).padStart(2, '0');
  for (let index = 0; index < canvases.length; index += 1) {
    const blob = await canvasToJpgBlob(canvases[index]);
    const name =
      canvases.length === 1
        ? getExportFileName(baseName, 'jpg')
        : getExportFileName(`${baseName}_page_${pad(index + 1)}_of_${pad(canvases.length)}`, 'jpg');
    downloadBlob(blob, name);
    if (index < canvases.length - 1) {
      await wait(250); // browsers drop back-to-back programmatic downloads
    }
  }
}

async function exportRasterPdf(webBook: WebBook): Promise<void> {
  const canvases = await renderPrintFriendlyReportCanvases(webBook);
  const { jsPDF } = await loadExportLibrary('jspdf', () => import('jspdf'));
  const doc = new jsPDF({ unit: 'pt', format: 'a4', orientation: 'portrait' });
  const a4WidthPt = 595.28;
  const a4HeightPt = 841.89;

  for (let index = 0; index < canvases.length; index += 1) {
    if (index > 0) {
      doc.addPage('a4', 'portrait');
    }
    const imgData = canvases[index].toDataURL('image/jpeg', JPEG_QUALITY);
    doc.addImage(imgData, 'JPEG', 0, 0, a4WidthPt, a4HeightPt, undefined, 'FAST');
  }

  downloadBlob(doc.output('blob'), getExportFileName(`${webBook.topic}_PrintFriendly_Report`, 'pdf'));
}

/**
 * PDF export. Primary path: the reader-mode document is printed by the browser (choose "Save as PDF"), which
 * yields vector text that stays sharp at any zoom or printer resolution and remains selectable/accessible.
 * If printing cannot be launched at all (no DOM, blocked), a 3x raster PDF is downloaded instead.
 */
export async function exportPrintFriendlyWebBookToPdf(webBook: WebBook): Promise<void> {
  // Open the popup synchronously: any await before this would lose the click's user activation.
  let popup: Window | null = null;
  const isCypress = typeof window !== 'undefined' && Boolean((window as unknown as { Cypress?: unknown }).Cypress);
  if (hasPrintableBrowser() && !isCypress && typeof window.open === 'function') {
    try {
      popup = window.open('', '_blank');
    } catch (error) {
      console.warn('Dedicated print window was blocked or unavailable:', error);
    }
  }

  const safeWebBook = sanitizeWebBookForPresentation(webBook);

  if (hasPrintableBrowser() && openPrintDialog(buildPrintFriendlyReportHtml(safeWebBook), popup)) {
    return;
  }
  await exportRasterPdf(safeWebBook);
}
