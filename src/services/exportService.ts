import type { WebBook } from '../types';
import type { DocxChapterImageAsset } from './docxExport';
import { buildWebBookDocx } from './docxExport';
import { getWebBookDocumentTitle } from './documentTitle';
import { getExportLabels } from './exportLabels';
import { getChapterSourceLinks, hasRealVisualCaption, sanitizeWebBookForPresentation } from '../utils/webBookRender';
import {
  buildPdfHtmlDocument,
  buildPrintHtmlDocument,
  buildStandaloneHtmlDocument,
  downloadBlob,
  getExportFileName,
  getWebBookElement,
  prepareExportContent,
} from './exportDocument';
import { loadExportLibrary } from './lazyExportLibs';
import { CjkFontUnavailableError, loadCjkFontBase64, prefetchCjkFont, registerCjkFont } from './pdfCjkFont';

function formatSourceLink(source: string | { title: string; url: string }): string {
  return typeof source === 'string' ? source : `${source.title} - ${source.url}`;
}

function getTextVisualWidth(str: string): number {
  let width = 0;
  for (const ch of str) {
    const code = ch.codePointAt(0) || 0;
    if (
      (code >= 0x1100 && code <= 0x11ff) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff01 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf)
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

export async function exportWebBookToTxt(webBook: WebBook): Promise<void> {
  const safeWebBook = sanitizeWebBookForPresentation(webBook);
  const L = getExportLabels(safeWebBook);
  let text = `${safeWebBook.topic.toUpperCase()}\n`;
  text += `${L.generatedOn}${L.colon}${new Date(safeWebBook.timestamp).toLocaleString(L.dateLocale)}\n\n`;

  text += `${L.upper(L.tableOfContents)}\n`;
  text += `${'='.repeat(getTextVisualWidth(L.upper(L.tableOfContents)))}\n\n`;
  safeWebBook.chapters.forEach((chapter, index) => {
    text += `${L.chapter(index + 1)}${L.colon}${chapter.title}\n`;
  });
  text += '\n\n';

  safeWebBook.chapters.forEach((chapter, index) => {
    const chapterHeading = `${L.upper(L.chapter(index + 1))}${L.colon}${chapter.title}`;
    text += `${chapterHeading}\n`;
    text += `${'='.repeat(getTextVisualWidth(chapterHeading))}\n\n`;
    text += `${chapter.content}\n\n`;
    if (hasRealVisualCaption(chapter)) {
      text += `${L.upper(L.visualConcept)}${L.colon}${chapter.visualSeed.trim()}\n\n`;
    }

    if (chapter.definitions && chapter.definitions.length > 0) {
      text += `${L.upper(L.coreConcepts)}${L.colon.trim()}\n`;
      chapter.definitions.forEach((definition) => {
        text += `- ${definition.term}: ${definition.description}\n`;
      });
      text += '\n';
    }

    if (chapter.subTopics && chapter.subTopics.length > 0) {
      text += `${L.upper(L.subTopics)}${L.colon.trim()}\n`;
      chapter.subTopics.forEach((subTopic) => {
        text += `- ${subTopic.title}: ${subTopic.summary}\n`;
      });
      text += '\n';
    }

    const sourceLinks = getChapterSourceLinks(chapter, { includeSearchResults: true, maxItems: 8 });
    if (sourceLinks.length > 0) {
      text += `${L.upper(L.sources)}${L.colon.trim()}\n`;
      sourceLinks.forEach((sourceLink) => {
        text += `- ${sourceLink.title} (${sourceLink.hostname}) - ${sourceLink.url}\n`;
      });
      text += '\n';
    }
    text += '\n';
  });

  downloadBlob(
    new Blob([text], { type: 'text/plain' }),
    getExportFileName(safeWebBook.topic, 'txt')
  );
}

export async function exportWebBookToHtml(webBook: WebBook): Promise<void> {
  const safeWebBook = sanitizeWebBookForPresentation(webBook);
  const { clone } = await prepareExportContent(getWebBookElement());
  const blob = new Blob([buildStandaloneHtmlDocument(safeWebBook, clone.outerHTML)], { type: 'text/html' });
  downloadBlob(blob, getExportFileName(safeWebBook.topic, 'html'));
}

export async function exportWebBookToWord(webBook: WebBook): Promise<void> {
  const safeWebBook = sanitizeWebBookForPresentation(webBook);
  const { chapterImages } = await prepareExportContent(getWebBookElement());
  const blob = new Blob([buildWebBookDocx(safeWebBook, chapterImages)], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });

  downloadBlob(blob, getExportFileName(safeWebBook.topic, 'docx'));
}

function webBookHasCjk(webBook: WebBook): boolean {
  const cjkRegex = /[\u1100-\u11ff\u2e80-\ua4cf\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/;
  if (cjkRegex.test(webBook?.topic || '')) return true;
  return (webBook?.chapters || []).some(
    (ch) =>
      cjkRegex.test(ch?.title || '') ||
      cjkRegex.test(ch?.content || '') ||
      (ch?.definitions || []).some((d) => cjkRegex.test(d?.term || '') || cjkRegex.test(d?.description || '')) ||
      (ch?.subTopics || []).some((s) => cjkRegex.test(s?.title || '') || cjkRegex.test(s?.summary || ''))
  );
}

/**
 * Called once a book is on screen. Loads the export libraries and, for CJK books, the 7 MB font in the background so that the export click
 * does not depend on downloads through the hosted preview's rate limit. Everything here is best effort and silent.
 */
export function prewarmExportAssets(webBook: WebBook): () => void {
  const timerId = setTimeout(() => {
    void loadExportLibrary('jspdf', () => import('jspdf')).catch(() => undefined);
    void loadExportLibrary('html2canvas', () => import('html2canvas')).catch(() => undefined);
    try {
      if (webBookHasCjk(webBook)) void prefetchCjkFont();
    } catch {
      /* ignore */
    }
  }, 2000);

  return () => {
    clearTimeout(timerId);
  };
}

export async function exportWebBookWithJsPdf(
  webBook: WebBook,
  chapterImages: Array<DocxChapterImageAsset | null> = []
): Promise<void> {
  const safeWebBook = sanitizeWebBookForPresentation(webBook);
  const L = getExportLabels(safeWebBook);

  // jsPDF's built-in fonts lack CJK glyphs, so CJK books register an embedded Unicode TrueType font and keep the
  // full High-Res layout. There is deliberately NO reroute to the reader-mode export here: if the font cannot be
  // loaded, loadCjkFontBase64 throws CjkFontUnavailableError and the caller surfaces it instead of swapping layouts.
  let cjkFontBase64: string | null = null;
  if (webBookHasCjk(safeWebBook)) {
    cjkFontBase64 = await loadCjkFontBase64();
  }

  const { jsPDF } = await loadExportLibrary('jspdf', () => import('jspdf'));
  const doc = new jsPDF({ unit: 'pt', format: 'a4', orientation: 'portrait' });
  if (cjkFontBase64) {
    registerCjkFont(doc, cjkFontBase64);
  }

  // Hook internal.write so every external URI link annotation is emitted with /NewWindow true.
  // The hook runs before jsPDF counts the bytes it writes, so offsets and the xref table stay valid.
  //
  // jsPDF writes an external link as one string ending in `/A <</S /URI /URI (<escaped url>) >>`.
  // The url is a PDF literal string in which jsPDF has already escaped `\`, `(` and `)`, so the match
  // must consume backslash escapes (`\\.`); a plain `[^)]+` stopped at the first `\)` and silently
  // skipped URLs such as https://en.wikipedia.org/wiki/Qubit_(quantum).
  // Internal links (TOC chapter jumps, Back to Top) are written as `/Dest [...]`, never match, and
  // are left untouched.
  //
  // Limitation: /NewWindow is not defined for URI actions in ISO 32000, so most viewers ignore it.
  // The URI action stays the primary action so the link remains clickable in every viewer.
  const EXTERNAL_URI_ACTION = /\/A\s*<<\s*\/S\s*\/URI\s*\/URI\s*\(((?:\\.|[^\\)])*)\)\s*>>/;
  const docInternal = doc.internal as any;
  const origWrite = docInternal.write.bind(docInternal);
  docInternal.write = function (...args: any[]) {
    return origWrite(
      ...args.map((arg) =>
        typeof arg === 'string'
          ? arg.replace(EXTERNAL_URI_ACTION, (_match, uri) => `/A <</S /URI /URI (${uri}) /NewWindow true >>`)
          : arg
      )
    );
  };

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 44;
  const contentWidth = pageWidth - margin * 2;
  const footerLimit = pageHeight - 48;

  // --- Page 1: Sleek Museum-Grade Cover Page ---
  doc.setFillColor(20, 20, 20);
  doc.rect(0, 0, pageWidth, pageHeight, 'F');

  // Top geometric badge
  doc.setDrawColor(228, 227, 224);
  doc.setLineWidth(1.5);
  doc.rect(pageWidth / 2 - 14, 180, 28, 28);
  doc.setFont('times', 'bolditalic');
  doc.setFontSize(14);
  doc.setTextColor(228, 227, 224);
  doc.text('E', pageWidth / 2, 199, { align: 'center' });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(170, 168, 164);
  doc.text(L.upper(L.engineName), pageWidth / 2, 230, { align: 'center' });

  // Main Cover Title - dynamic font size and line spacing to elegantly accommodate long topics without collision
  doc.setTextColor(255, 255, 255);
  doc.setFont('times', 'bolditalic');

  const rawTopic = safeWebBook.topic.trim();
  let titleFontSize = 28;
  if (rawTopic.length > 200) {
    titleFontSize = 16;
  } else if (rawTopic.length > 120) {
    titleFontSize = 18;
  } else if (rawTopic.length > 60) {
    titleFontSize = 22;
  }

  doc.setFontSize(titleFontSize);
  const lineHeightFactor = 1.35;
  doc.setLineHeightFactor(lineHeightFactor);
  const lineHeight = titleFontSize * lineHeightFactor;

  const coverTitleLines = doc.splitTextToSize(rawTopic.toUpperCase(), contentWidth - 40);
  const totalTitleHeight = (coverTitleLines.length - 1) * lineHeight;

  // Vertically position title with adequate clearance below top badge (Y=230)
  const titleY = Math.max(265, 345 - totalTitleHeight / 2);
  doc.text(coverTitleLines, pageWidth / 2, titleY, { align: 'center' });

  // Accent divider line - positioned with guaranteed margin below the actual rendered title bottom
  doc.setDrawColor(228, 227, 224);
  doc.setLineWidth(1);
  const titleBottomY = titleY + totalTitleHeight;
  const dividerY = titleBottomY + 30;
  doc.line(pageWidth / 2 - 40, dividerY, pageWidth / 2 + 40, dividerY);

  // Metadata 3-column stats - guaranteed spacing below divider
  const metaY = dividerY + 35;
  const col1 = margin + contentWidth * 0.2;
  const col2 = pageWidth / 2;
  const col3 = pageWidth - margin - contentWidth * 0.2;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(160, 158, 154);
  doc.text(L.upper(L.chapters), col1, metaY, { align: 'center' });
  doc.text(L.upper(L.concepts), col2, metaY, { align: 'center' });
  doc.text(L.upper(L.date), col3, metaY, { align: 'center' });

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.setTextColor(255, 255, 255);
  const conceptCount = safeWebBook.chapters.reduce(
    (acc, ch) => acc + (Array.isArray(ch.definitions) ? ch.definitions.length : 0),
    0
  );
  doc.text(String(safeWebBook.chapters.length), col1, metaY + 24, { align: 'center' });
  doc.text(String(conceptCount), col2, metaY + 24, { align: 'center' });
  doc.text(
    new Date(safeWebBook.timestamp).toLocaleDateString(L.dateLocale, { month: 'short', year: 'numeric' }),
    col3,
    metaY + 24,
    { align: 'center' }
  );

  // Bottom subtitle
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(140, 138, 134);
  doc.text(L.upper(L.tagline), pageWidth / 2, pageHeight - 50, { align: 'center' });

  // --- Page 2: Table of Contents Placeholder (Filled in Pass 2) ---
  doc.addPage();

  // --- Pass 1: Render All Chapters ---
  const chapterStartPages: number[] = [];
  let currentY = 60;

  function checkPageSpace(needed: number) {
    if (currentY + needed > footerLimit) {
      doc.addPage();
      currentY = 60;
    }
  }

  const isCjk = Boolean(cjkFontBase64);

  function drawSectionBadge(label: string, minWidth: number) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    const textWidth = doc.getTextWidth(label);
    const badgeW = isCjk ? Math.max(textWidth + 18, 56) : Math.max(minWidth, textWidth + 18);
    doc.setFillColor(20, 20, 20);
    doc.rect(margin, currentY, badgeW, 14, 'F');
    doc.setTextColor(255, 255, 255);
    doc.text(label, margin + badgeW / 2, currentY + 9.5, { align: 'center' });

    doc.setDrawColor(220, 220, 220);
    doc.setLineWidth(0.5);
    doc.line(margin + badgeW + 6, currentY + 7, pageWidth - margin, currentY + 7);
    currentY += 22;
  }

  safeWebBook.chapters.forEach((chapter, index) => {
    doc.addPage();
    chapterStartPages.push(doc.getNumberOfPages());
    currentY = 60;

    // Chapter Header Box
    doc.setFillColor(20, 20, 20);
    doc.rect(margin, currentY, 28, 28, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.text(String(index + 1).padStart(2, '0'), margin + 14, currentY + 18, { align: 'center' });

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(120, 120, 120);
    doc.text(`${L.upper(L.chapterOf(index + 1, safeWebBook.chapters.length))}   |   ${L.upper(L.overviewNarrative)}`, margin + 38, currentY + 9);

    doc.setFont('times', 'bolditalic');
    doc.setFontSize(18);
    doc.setTextColor(20, 20, 20);
    const chTitleLines = doc.splitTextToSize(chapter.title, contentWidth - 42);
    doc.text(chTitleLines, margin + 38, currentY + 29);
    currentY += Math.max(38, 14 + chTitleLines.length * 20) + 12;

    // Header hairline separator
    doc.setDrawColor(220, 220, 220);
    doc.setLineWidth(0.75);
    doc.line(margin, currentY, pageWidth - margin, currentY);
    currentY += 16;

    // Chapter Image (if inlined) or Visual Concept Seed Box
    const imgAsset = chapterImages[index];
    if (imgAsset && imgAsset.bytes && imgAsset.bytes.length > 0) {
      try {
        const imgMaxW = contentWidth - 40;
        const imgMaxH = 180;
        const aspect = (imgAsset.widthPx && imgAsset.heightPx) ? (imgAsset.widthPx / imgAsset.heightPx) : (16 / 9);
        let imgW = Math.min(imgMaxW, imgMaxH * aspect);
        let imgH = imgW / aspect;
        if (imgH > imgMaxH) {
          imgH = imgMaxH;
          imgW = imgH * aspect;
        }
        checkPageSpace(imgH + 40);
        const imgX = margin + (contentWidth - imgW) / 2;
        doc.addImage(imgAsset.bytes, imgAsset.extension.toUpperCase(), imgX, currentY, imgW, imgH);
        currentY += imgH + 8;

        if (hasRealVisualCaption(chapter)) {
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(7.5);
          doc.setTextColor(120, 120, 120);
          doc.text(`${L.visualConcept}${L.colon}"${chapter.visualSeed}"`, margin + contentWidth / 2, currentY + 8, { align: 'center' });
          currentY += 16;
        }
      } catch (imgErr) {
        console.warn('Failed to draw chapter image in PDF:', imgErr);
      }
    } else if (hasRealVisualCaption(chapter)) {
      const seedLines = doc.splitTextToSize(`"${chapter.visualSeed}"`, contentWidth - 28);
      const boxHeight = 24 + seedLines.length * 12;
      checkPageSpace(boxHeight + 12);
      doc.setFillColor(248, 247, 245);
      doc.setDrawColor(20, 20, 20);
      doc.setLineWidth(0.5);
      doc.rect(margin, currentY, contentWidth, boxHeight, 'FD');

      // Badge
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(6.5);
      const seedBadge = L.upper(L.visualConceptSeed);
      const seedBadgeW = isCjk ? Math.max(56, doc.getTextWidth(seedBadge) + 16) : Math.max(88, doc.getTextWidth(seedBadge) + 16);
      doc.setFillColor(20, 20, 20);
      doc.rect(margin + 12, currentY + 8, seedBadgeW, 12, 'F');
      doc.setTextColor(255, 255, 255);
      doc.text(seedBadge, margin + 12 + seedBadgeW / 2, currentY + 16.5, { align: 'center' });

      doc.setFont('times', 'italic');
      doc.setFontSize(9);
      doc.setTextColor(60, 60, 60);
      doc.text(seedLines, margin + 12, currentY + 28);
      currentY += boxHeight + 16;
    }

    // Editorial Prose Paragraphs
    const paragraphs = chapter.content.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    paragraphs.forEach((paragraph, pIdx) => {
      if (pIdx === 0) {
        // Styled lead paragraph with vertical accent bar
        doc.setFont('times', 'normal');
        doc.setFontSize(11);
        doc.setTextColor(25, 25, 25);
        const leadLines = doc.splitTextToSize(paragraph, contentWidth - 16);
        checkPageSpace(leadLines.length * 15 + 16);

        doc.setDrawColor(20, 20, 20);
        doc.setLineWidth(2.5);
        doc.line(margin, currentY + 2, margin, currentY + leadLines.length * 15 - 2);

        doc.text(leadLines, margin + 14, currentY + 11);
        currentY += leadLines.length * 15 + 16;
      } else {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9.5);
        doc.setTextColor(50, 50, 50);
        const bodyLines = doc.splitTextToSize(paragraph, contentWidth);
        checkPageSpace(bodyLines.length * 14 + 12);
        doc.text(bodyLines, margin, currentY + 10);
        currentY += bodyLines.length * 14 + 12;
      }
    });

    // Core Concepts Callout Cards
    if (chapter.definitions && chapter.definitions.length > 0) {
      checkPageSpace(100);
      currentY += 8;
      drawSectionBadge(L.upper(L.keyDomainConcepts), 110);

      chapter.definitions.forEach((def) => {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8.5);
        const descLines = doc.splitTextToSize(def.description, contentWidth - 24);
        const cardHeight = (def.sourceUrl ? 36 : 24) + descLines.length * 11.5;
        checkPageSpace(cardHeight + 8);

        doc.setFillColor(252, 252, 251);
        doc.setDrawColor(225, 225, 225);
        doc.setLineWidth(0.5);
        doc.rect(margin, currentY, contentWidth, cardHeight, 'FD');

        doc.setDrawColor(20, 20, 20);
        doc.setLineWidth(2.5);
        doc.line(margin, currentY, margin, currentY + cardHeight);

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9);
        doc.setTextColor(20, 20, 20);
        doc.text(def.term, margin + 12, currentY + 13);

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8.5);
        doc.setTextColor(70, 70, 70);
        doc.text(descLines, margin + 12, currentY + 25);

        if (def.sourceUrl) {
          const linkY = currentY + 27 + descLines.length * 11.5;
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(8);
          doc.setTextColor(30, 58, 138);
          const linkText = `${L.sourceArticle} »`;
          doc.text(linkText, margin + 12, linkY);
          const linkW = Math.max(70, doc.getTextWidth(linkText) + 4);
          doc.link(margin + 12, linkY - 8, linkW, 11, { url: def.sourceUrl });
        }

        currentY += cardHeight + 8;
      });
    }

    // Deeper Angles & Sub-Topics Cards
    if (chapter.subTopics && chapter.subTopics.length > 0) {
      checkPageSpace(100);
      currentY += 8;
      drawSectionBadge(L.upper(L.deeperAngles), 140);

      chapter.subTopics.forEach((sub) => {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8.5);
        const sumLines = doc.splitTextToSize(sub.summary, contentWidth - 24);
        const cardHeight = (sub.sourceUrl ? 36 : 24) + sumLines.length * 11.5;
        checkPageSpace(cardHeight + 8);

        doc.setFillColor(249, 250, 251);
        doc.setDrawColor(215, 220, 225);
        doc.setLineWidth(0.5);
        doc.rect(margin, currentY, contentWidth, cardHeight, 'FD');

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9);
        doc.setTextColor(20, 20, 20);
        doc.text(sub.title, margin + 12, currentY + 13);

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8.5);
        doc.setTextColor(70, 70, 70);
        doc.text(sumLines, margin + 12, currentY + 25);

        if (sub.sourceUrl) {
          const linkY = currentY + 27 + sumLines.length * 11.5;
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(8);
          doc.setTextColor(30, 58, 138);
          const linkText = `${L.sourceArticle} »`;
          doc.text(linkText, margin + 12, linkY);
          const linkW = Math.max(70, doc.getTextWidth(linkText) + 4);
          doc.link(margin + 12, linkY - 8, linkW, 11, { url: sub.sourceUrl });
        }

        currentY += cardHeight + 8;
      });
    }

    // Verified Source Citations with Clickable Links (Deduplicated)
    const uniqueSources = getChapterSourceLinks(chapter, { includeSearchResults: true, maxItems: 8 });
    if (uniqueSources.length > 0) {
      checkPageSpace(80);
      currentY += 8;
      drawSectionBadge(L.upper(L.verifiedSources), 130);

      uniqueSources.forEach((sourceLink) => {
        checkPageSpace(20);

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8.5);
        doc.setTextColor(30, 58, 138);

        const displayTitle = sourceLink.title || sourceLink.hostname;
        const maxSourceTitleLen = cjkFontBase64 ? 38 : 70;
        const truncatedTitle = displayTitle.length > maxSourceTitleLen ? `${displayTitle.slice(0, maxSourceTitleLen)}...` : displayTitle;
        const lineText = `• [${sourceLink.hostname}] ${truncatedTitle}`;

        doc.text(lineText, margin + 8, currentY + 10);
        const textW = doc.getTextWidth(lineText);
        doc.link(margin + 8, currentY, textW, 12, { url: sourceLink.url });
        currentY += 16;
      });
    }
  });

  // --- Final Section: Synthesis Verified & Back to Top Hyperlink ---
  checkPageSpace(52);
  currentY += 14;
  doc.setFillColor(245, 245, 245);
  doc.setDrawColor(20, 20, 20);
  doc.setLineWidth(0.5);
  doc.rect(margin, currentY, contentWidth, 36, 'FD');

  // Green checkmark badge
  doc.setFillColor(220, 252, 231);
  doc.circle(margin + 20, currentY + 18, 9, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(22, 163, 74);
  doc.text('✓', margin + 20, currentY + 21, { align: 'center' });

  // Status text
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(20, 20, 20);
  doc.text(L.upper(L.synthesisVerified), margin + 36, currentY + 15);

  doc.setFont('courier', 'normal');
  doc.setFontSize(6.5);
  doc.setTextColor(110, 110, 110);
  doc.text(L.passComplete, margin + 36, currentY + 25);

  // "Back to Top" hyperlink (Internal navigation jumping back to Page 1)
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(20, 20, 20);
  const backToTopText = `${L.upper(L.backToTop)} »`;
  const backToTopWidth = doc.getTextWidth(backToTopText);
  const backToTopX = pageWidth - margin - backToTopWidth - 14;
  const backToTopY = currentY + 20;
  doc.text(backToTopText, backToTopX, backToTopY);

  // Underline
  doc.setDrawColor(20, 20, 20);
  doc.setLineWidth(0.5);
  doc.line(backToTopX, backToTopY + 2, backToTopX + backToTopWidth, backToTopY + 2);

  // Clickable internal link jumping back to Page 1 (Top of book)
  doc.link(backToTopX - 4, currentY + 4, backToTopWidth + 8, 28, { pageNumber: 1 });

  // --- Pass 2: Render Table of Contents on Page 2 with Working Hyperlinks ---
  doc.setPage(2);
  doc.setFillColor(250, 250, 250);
  doc.rect(0, 0, pageWidth, pageHeight, 'F');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.setTextColor(20, 20, 20);
  doc.text(L.upper(L.tableOfContents), margin, 70);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(110, 110, 110);
  doc.text(L.upper(L.tocHint), margin, 84);

  doc.setDrawColor(20, 20, 20);
  doc.setLineWidth(1.5);
  doc.line(margin, 92, pageWidth - margin, 92);

  let tocY = 125;
  safeWebBook.chapters.forEach((chapter, index) => {
    const pNum = chapterStartPages[index];

    // Chapter Number Badge
    doc.setFillColor(20, 20, 20);
    doc.rect(margin, tocY - 11, 20, 16, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.text(`0${index + 1}`, margin + 10, tocY + 0.5, { align: 'center' });

    // Chapter Title
    doc.setTextColor(20, 20, 20);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10.5);
    const maxTitleLen = cjkFontBase64 ? 30 : 50;
    const displayTitle = chapter.title.length > maxTitleLen ? `${chapter.title.slice(0, maxTitleLen)}...` : chapter.title;
    doc.text(displayTitle, margin + 28, tocY);

    const titleW = doc.getTextWidth(displayTitle);
    const pageLabel = L.pageRef(pNum);
    const pageW = doc.getTextWidth(pageLabel);

    // Dotted leader line
    const dotStart = margin + 32 + titleW;
    const dotEnd = pageWidth - margin - pageW - 8;
    if (dotEnd > dotStart) {
      doc.setDrawColor(180, 180, 180);
      doc.setLineDashPattern([1.5, 3], 0);
      doc.line(dotStart, tocY - 2, dotEnd, tocY - 2);
      doc.setLineDashPattern([], 0);
    }

    // Page number
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(80, 80, 80);
    doc.text(pageLabel, pageWidth - margin, tocY, { align: 'right' });

    // CLICKABLE INTERNAL HYPERLINK TO JUMP TO CHAPTER PAGE!
    doc.link(margin, tocY - 12, contentWidth, 20, { pageNumber: pNum });

    tocY += 28;
  });

  // --- Running Headers & Footers across Pages 2 to Total ---
  const totalPages = doc.getNumberOfPages();
  for (let p = 2; p <= totalPages; p += 1) {
    doc.setPage(p);

    // Running Header
    doc.setDrawColor(225, 225, 225);
    doc.setLineWidth(0.5);
    doc.line(margin, 36, pageWidth - margin, 36);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(140, 140, 140);
    doc.text(L.upper(L.engineName), margin, 30);
    const maxTopicLen = 50;
    const displayTopic = safeWebBook.topic.length > maxTopicLen ? `${safeWebBook.topic.slice(0, maxTopicLen)}...` : safeWebBook.topic;
    doc.text(displayTopic.toUpperCase(), pageWidth - margin, 30, { align: 'right' });

    // Running Footer
    doc.setDrawColor(225, 225, 225);
    doc.setLineWidth(0.5);
    doc.line(margin, pageHeight - 34, pageWidth - margin, pageHeight - 34);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(150, 150, 150);
    doc.text(L.upper(L.tagline), margin, pageHeight - 22);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(60, 60, 60);
    doc.text(L.upper(L.pageOf(p, totalPages)), pageWidth - margin, pageHeight - 22, { align: 'right' });
  }

  const pdfBlob = doc.output('blob');
  downloadBlob(pdfBlob, getExportFileName(safeWebBook.topic, 'pdf'));
}

export async function exportWebBookToPdf(webBook: WebBook): Promise<void> {
  const safeWebBook = sanitizeWebBookForPresentation(webBook);
  const element = getWebBookElement();
  const { clone, chapterImages } = await prepareExportContent(element, { inlineImages: true });

  // 1. Attempt fast server-side PDF generation if route is available (for Cypress stub or server)
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2500);

    const response = await fetch('/__pdf', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        html: buildPdfHtmlDocument(safeWebBook, clone.outerHTML),
        fileName: safeWebBook.topic.replace(/\s+/g, '_'),
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      const blob = await response.blob();
      if (blob.size > 0 && (blob.type.includes('pdf') || blob.type === 'application/octet-stream')) {
        downloadBlob(blob, getExportFileName(safeWebBook.topic, 'pdf'));
        return;
      }
    }
  } catch (serverErr) {
    console.warn('Server PDF endpoint not available or timed out, proceeding to client-side vector generation...', serverErr);
  }

  // 2. High-resolution vector PDF generation with interactive TOC hyperlinks and editorial layout (no silent fallback to print)
  try {
    await exportWebBookWithJsPdf(safeWebBook, chapterImages);
    return;
  } catch (vectorErr) {
    // A missing CJK font must not silently switch to another layout; report it to the user instead.
    if (vectorErr instanceof CjkFontUnavailableError || (vectorErr as Error)?.name === 'CjkFontUnavailableError') {
      const attempts = (vectorErr as any)?.attempts;
      if (Array.isArray(attempts) && attempts.length > 0) {
        console.warn('CJK font loading failed across candidate locations:', attempts.join('; '));
      }
      throw vectorErr;
    }
    // This used to fall back to the print dialog without a word, so "PDF Document (High Res)" silently turned into
    // "Print / Save as PDF" whenever anything inside the jsPDF export threw, and nobody could tell why. The two menu
    // entries are different exports: report the failure (with the real reason, also in the console) and leave the
    // choice of the print route to the user.
    console.error('High-Res PDF export (jsPDF) failed:', vectorErr);
    const reason = String((vectorErr as Error)?.message || vectorErr || 'unknown error').split('\n')[0].slice(0, 200);
    throw new Error(`The High-Res PDF could not be created (${reason}). Use "Print / Save as PDF" instead, or try again.`);
  }
}

let isPrintingInProgress = false;

export async function printWebBook(webBook: WebBook): Promise<void> {
  if (isPrintingInProgress) {
    console.warn('Print operation is already in progress.');
    return;
  }
  isPrintingInProgress = true;

  const isCypress = typeof window !== 'undefined' && Boolean((window as unknown as { Cypress?: unknown }).Cypress);

  // Synchronously open a dedicated window/tab when not in Cypress to preserve the user gesture.
  // In Google AI Studio GUI (where the app runs inside a sandboxed iframe), opening a top-level
  // window escapes nested iframe printing restrictions and allows native window.print() to run cleanly.
  let printWindow: Window | null = null;
  if (!isCypress) {
    try {
      printWindow = window.open('', '_blank');
    } catch (openErr) {
      console.warn('Dedicated print window open was blocked or unavailable:', openErr);
    }
  }

  const safeWebBook = sanitizeWebBookForPresentation(webBook);
  const printTitle = getWebBookDocumentTitle(safeWebBook.topic);
  const printFileName = getExportFileName(safeWebBook.topic, 'pdf');

  try {
    const { clone } = await prepareExportContent(getWebBookElement());
    const htmlContent = buildPrintHtmlDocument(safeWebBook, clone.outerHTML);

    if (printWindow && printWindow.document) {
      try {
        const printScript = `
          <script>
            document.title = ${JSON.stringify(printTitle)};
            const triggerPrint = () => {
              setTimeout(() => {
                window.print();
              }, 750);
            };
            if (document.readyState === 'complete') {
              triggerPrint();
            } else {
              window.addEventListener('load', triggerPrint, { once: true });
            }
          </script>
        `;
        const popupHtml = htmlContent.includes('</body>')
          ? htmlContent.replace('</body>', `${printScript}</body>`)
          : `${htmlContent}${printScript}`;

        printWindow.document.open();
        printWindow.document.write(popupHtml);
        printWindow.document.title = printTitle;
        printWindow.document.close();

        // Print operation delegated to dedicated top-level window
        isPrintingInProgress = false;
        return;
      } catch (writeErr) {
        console.warn('Failed writing to dedicated print window, falling back to iframe print:', writeErr);
        try {
          printWindow.close();
        } catch {}
      }
    }

    // Fallback path: hidden iframe print approach (used in Cypress test harness or strict popup blockers)
    const iframe = document.createElement('iframe');
    iframe.style.position = 'fixed';
    iframe.style.top = '0';
    iframe.style.left = '0';
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    iframe.style.border = '0';
    iframe.style.zIndex = '-9999';
    iframe.style.opacity = '0';
    iframe.style.pointerEvents = 'none';
    iframe.title = printTitle;
    iframe.name = printFileName;
    document.body.appendChild(iframe);

    const iframeWindow = iframe.contentWindow;
    const iframeDoc = iframeWindow?.document;

    let hasExecuted = false;
    let isCleanedUp = false;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    let readyTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (isCleanedUp) return;
      isCleanedUp = true;
      isPrintingInProgress = false;

      if (fallbackTimer) {
        clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
      if (readyTimer) {
        clearTimeout(readyTimer);
        readyTimer = null;
      }

      try {
        iframeWindow?.removeEventListener?.('afterprint', cleanup);
      } catch {}
      try {
        window.removeEventListener?.('afterprint', cleanup);
      } catch {}

      // Allow the browser print preview UI to fully settle before detaching iframe
      setTimeout(() => {
        try {
          if (iframe.parentNode) {
            iframe.parentNode.removeChild(iframe);
          }
        } catch {}
      }, 300);
    };

    const executePrint = () => {
      if (hasExecuted) return;
      hasExecuted = true;

      if (fallbackTimer) {
        clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
      if (readyTimer) {
        clearTimeout(readyTimer);
        readyTimer = null;
      }

      try {
        if (iframeWindow) {
          try {
            iframeWindow.addEventListener('afterprint', cleanup, { once: true });
          } catch {}
          try {
            window.addEventListener('afterprint', cleanup, { once: true });
          } catch {}

          iframeWindow.focus();
          iframeWindow.print();
        } else {
          window.print();
          cleanup();
        }
      } catch (printErr) {
        console.warn('Iframe print failed, falling back to window.print():', printErr);
        try {
          window.print();
        } catch (winErr) {
          console.warn('Direct window print also failed:', winErr);
        }
        cleanup();
      }
    };

    if (iframeWindow && iframeDoc) {
      try {
        iframeDoc.open();
        iframeDoc.write(htmlContent);
        iframeDoc.title = printTitle;
        iframeDoc.close();

        // Fallback timer: trigger print if onload doesn't fire within 800ms
        fallbackTimer = setTimeout(() => {
          executePrint();
        }, 800);

        if (iframeDoc.readyState === 'complete') {
          readyTimer = setTimeout(executePrint, 150);
        } else {
          iframe.onload = () => {
            readyTimer = setTimeout(executePrint, 100);
          };
        }
      } catch (frameErr) {
        console.warn('Failed to write to print iframe, falling back to window.print():', frameErr);
        try {
          window.print();
        } catch (winErr) {
          console.warn('Window print failed:', winErr);
        }
        cleanup();
      }
    } else {
      try {
        window.print();
      } catch (winErr) {
        console.warn('Direct print failed:', winErr);
      }
      cleanup();
    }
  } catch (err) {
    console.error('printWebBook encountered an error:', err);
    isPrintingInProgress = false;
    if (printWindow) {
      try {
        printWindow.close();
      } catch {}
    }
  }
}

export {
  exportPrintFriendlyWebBookToImage,
  exportPrintFriendlyWebBookToPdf,
} from './printFriendlyReportExport';
