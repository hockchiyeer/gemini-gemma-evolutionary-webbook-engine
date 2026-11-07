import { getExportLabels } from './exportLabels';
import { strToU8, zipSync } from 'fflate';
import type { Chapter, WebBook } from '../types';
import { buildChapterRenderPlan, getChapterSourceLinks } from '../utils/webBookRender';

export interface DocxChapterImageAsset {
  altText: string;
  bytes: Uint8Array;
  contentType: 'image/jpeg' | 'image/png' | 'image/gif';
  extension: 'jpeg' | 'jpg' | 'png' | 'gif';
  widthPx: number;
  heightPx: number;
}

type ParagraphOptions = {
  alignment?: 'left' | 'center' | 'right';
  keepLines?: boolean;
  keepNext?: boolean;
  pageBreakBefore?: boolean;
  spacingBefore?: number;
  spacingAfter?: number;
  style?: 'Title' | 'Subtitle' | 'Heading1' | 'Heading2' | 'Heading3' | 'Caption';
};

type TextRunOptions = {
  bold?: boolean;
  color?: string;
  italic?: boolean;
  mono?: boolean;
  sizeHalfPoints?: number;
};

const DOC_TITLE_MARKER_PATTERN = /^(?:(?:\[(?:pdf|doc|docs|docx|docss)\]|\((?:pdf|doc|docs|docx|docss)\)|(?:pdf|doc|docs|docx|docss)\b)\s*[-:|]?\s*)+/i;
const GENERIC_DOCX_TITLE_SEGMENT_PATTERN = /^(?:introduction|overview|abstract|summary|contents?)$/i;

const WORD_MAIN_NAMESPACE = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const WORD_REL_NAMESPACE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_REL_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/relationships';
const DRAWING_NAMESPACE = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const WORD_DRAWING_NAMESPACE = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const PICTURE_NAMESPACE = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
const CORE_PROPS_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties';
const DC_NAMESPACE = 'http://purl.org/dc/elements/1.1/';
const DCTERMS_NAMESPACE = 'http://purl.org/dc/terms/';
const DCMITYPE_NAMESPACE = 'http://purl.org/dc/dcmitype/';
const XSI_NAMESPACE = 'http://www.w3.org/2001/XMLSchema-instance';

const A4_PAGE_WIDTH_TWIPS = 11906;
const A4_PAGE_HEIGHT_TWIPS = 16838;
const PAGE_MARGIN_TWIPS = 900;
const MAX_IMAGE_WIDTH_EMU = 6_200_000;
const MAX_IMAGE_HEIGHT_EMU = 4_400_000;

const stripChapterPrefix = (value: string) => value.replace(/^Chapter\s+\d+:\s*/i, '').trim();

let nextBookmarkId = 1;

function bookmark(name: string, content: string): string {
  const id = nextBookmarkId++;
  return (
    `<w:bookmarkStart w:id="${id}" w:name="${escapeXml(name)}"/>` +
    content +
    `<w:bookmarkEnd w:id="${id}"/>`
  );
}

function internalLink(anchor: string, text: string): string {
  return (
    `<w:hyperlink w:anchor="${escapeXml(anchor)}" w:history="1">` +
    '<w:r>' +
    '<w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr>' +
    `<w:t>${escapeXml(text)}</w:t>` +
    '</w:r>' +
    '</w:hyperlink>'
  );
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildChapterHeading(chapter: Chapter, index: number) {
  const raw = stripChapterPrefix(chapter.title || '');
  const normalized = raw.replace(/\s+/g, ' ').trim();
  const sanitizedWholeTitle = normalized
    .replace(DOC_TITLE_MARKER_PATTERN, '')
    .replace(/\s*[|:]\s*$/, '')
    .trim();

  const segments = normalized
    .split(/\s*[:|]\s*/)
    .map((segment) => segment.replace(DOC_TITLE_MARKER_PATTERN, '').trim())
    .map((segment) => segment.replace(/\s*[|:]\s*$/, '').trim())
    .filter(Boolean);

  const rankedSegments = segments
    .map((segment) => {
      let score = Math.min(segment.length, 120);

      if (!DOC_TITLE_MARKER_PATTERN.test(segment)) {
        score += 60;
      }

      if (!GENERIC_DOCX_TITLE_SEGMENT_PATTERN.test(segment)) {
        score += 20;
      }

      if (/\s/.test(segment)) {
        score += 10;
      }

      return { segment, score };
    })
    .sort((left, right) => right.score - left.score || right.segment.length - left.segment.length);

  const displayTitle = rankedSegments[0]?.segment || sanitizedWholeTitle || raw || chapter.title || `Chapter ${index + 1}`;

  return {
    sequence: String(index + 1).padStart(2, '0'),
    facetLabel: '',
    displayTitle,
  };
}

function textRun(text: string, options: TextRunOptions = {}): string {
  const runProperties = [
    options.bold ? '<w:b/>' : '',
    options.italic ? '<w:i/>' : '',
    options.color ? `<w:color w:val="${escapeXml(options.color)}"/>` : '',
    options.mono ? '<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/>' : '',
    options.sizeHalfPoints ? `<w:sz w:val="${options.sizeHalfPoints}"/><w:szCs w:val="${options.sizeHalfPoints}"/>` : '',
  ].join('');
  const preserveSpace = /^[\s]|[\s]$|\s{2,}/.test(text);

  return `<w:r>${runProperties ? `<w:rPr>${runProperties}</w:rPr>` : ''}<w:t${preserveSpace ? ' xml:space="preserve"' : ''}>${escapeXml(text)}</w:t></w:r>`;
}

function paragraph(inlineXml: string | string[], options: ParagraphOptions = {}): string {
  const paragraphProperties = [
    options.style ? `<w:pStyle w:val="${options.style}"/>` : '',
    options.alignment ? `<w:jc w:val="${options.alignment}"/>` : '',
    options.keepLines ? '<w:keepLines/>' : '',
    options.keepNext ? '<w:keepNext/>' : '',
    options.pageBreakBefore ? '<w:pageBreakBefore/>' : '',
    (options.spacingBefore || options.spacingAfter)
      ? `<w:spacing${options.spacingBefore ? ` w:before="${options.spacingBefore}"` : ''}${options.spacingAfter ? ` w:after="${options.spacingAfter}"` : ''}/>`
      : '',
  ].join('');
  const content = Array.isArray(inlineXml) ? inlineXml.join('') : inlineXml;
  const safeContent = content || '<w:r/>';

  return `<w:p>${paragraphProperties ? `<w:pPr>${paragraphProperties}</w:pPr>` : ''}${safeContent}</w:p>`;
}

function pageBreak(): string {
  return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
}

function toIsoTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function splitIntoParagraphs(content: string): string[] {
  const normalized = content.trim();
  if (!normalized) return [];

  const explicitParagraphs = normalized
    .split(/\n{2,}/)
    .map((paragraphText) => paragraphText.trim())
    .filter(Boolean);

  if (explicitParagraphs.length > 1) {
    return explicitParagraphs;
  }

  const sentences = normalized
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  if (sentences.length <= 3) {
    return [normalized];
  }

  return [
    sentences.slice(0, 3).join(' '),
    sentences.slice(3).join(' '),
  ].filter(Boolean);
}

function fitImageWithinBounds(widthPx: number, heightPx: number): { widthEmu: number; heightEmu: number } {
  const safeWidth = Math.max(1, widthPx || 1);
  const safeHeight = Math.max(1, heightPx || 1);
  const widthScale = MAX_IMAGE_WIDTH_EMU / safeWidth;
  const heightScale = MAX_IMAGE_HEIGHT_EMU / safeHeight;
  const scale = Math.min(widthScale, heightScale, 1);

  return {
    widthEmu: Math.max(1, Math.round(safeWidth * scale)),
    heightEmu: Math.max(1, Math.round(safeHeight * scale)),
  };
}

function buildImageParagraph(
  relationshipId: string,
  imageName: string,
  altText: string,
  widthPx: number,
  heightPx: number,
  drawingId: number,
): string {
  const { widthEmu, heightEmu } = fitImageWithinBounds(widthPx, heightPx);
  return (
    '<w:p>' +
    '<w:pPr><w:jc w:val="center"/><w:spacing w:before="120" w:after="200"/></w:pPr>' +
    '<w:r>' +
    '<w:drawing>' +
    '<wp:inline distT="0" distB="0" distL="0" distR="0">' +
    `<wp:extent cx="${widthEmu}" cy="${heightEmu}"/>` +
    `<wp:docPr id="${drawingId}" name="${escapeXml(imageName)}" descr="${escapeXml(altText)}"/>` +
    '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
    '<a:graphic>' +
    `<a:graphicData uri="${PICTURE_NAMESPACE}">` +
    `<pic:pic xmlns:pic="${PICTURE_NAMESPACE}">` +
    '<pic:nvPicPr>' +
    `<pic:cNvPr id="0" name="${escapeXml(imageName)}" descr="${escapeXml(altText)}"/>` +
    '<pic:cNvPicPr/>' +
    '</pic:nvPicPr>' +
    '<pic:blipFill>' +
    `<a:blip r:embed="${relationshipId}"/>` +
    '<a:stretch><a:fillRect/></a:stretch>' +
    '</pic:blipFill>' +
    '<pic:spPr>' +
    `<a:xfrm><a:off x="0" y="0"/><a:ext cx="${widthEmu}" cy="${heightEmu}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' +
    '</pic:spPr>' +
    '</pic:pic>' +
    '</a:graphicData>' +
    '</a:graphic>' +
    '</wp:inline>' +
    '</w:drawing>' +
    '</w:r>' +
    '</w:p>'
  );
}

function buildStylesXml(): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:styles xmlns:w="${WORD_MAIN_NAMESPACE}">` +
    '<w:docDefaults>' +
    '<w:rPrDefault>' +
    '<w:rPr>' +
    '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/>' +
    '<w:sz w:val="22"/><w:szCs w:val="22"/>' +
    '<w:lang w:val="en-US"/>' +
    '</w:rPr>' +
    '</w:rPrDefault>' +
    '<w:pPrDefault><w:pPr><w:spacing w:after="160"/></w:pPr></w:pPrDefault>' +
    '</w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Title">' +
    '<w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/>' +
    '<w:pPr><w:jc w:val="center"/><w:spacing w:before="320" w:after="220"/></w:pPr>' +
    '<w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia" w:cs="Georgia"/><w:b/><w:sz w:val="40"/><w:szCs w:val="40"/></w:rPr>' +
    '</w:style>' +
    '<w:style w:type="paragraph" w:styleId="Subtitle">' +
    '<w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:qFormat/>' +
    '<w:pPr><w:jc w:val="center"/><w:spacing w:after="180"/></w:pPr>' +
    '<w:rPr><w:color w:val="6B5B4A"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr>' +
    '</w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading1">' +
    '<w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
    '<w:pPr><w:outlineLvl w:val="0"/><w:spacing w:before="260" w:after="140"/></w:pPr>' +
    '<w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia" w:cs="Georgia"/><w:b/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr>' +
    '</w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading2">' +
    '<w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
    '<w:pPr><w:outlineLvl w:val="1"/><w:spacing w:before="220" w:after="120"/></w:pPr>' +
    '<w:rPr><w:b/><w:color w:val="1D1710"/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr>' +
    '</w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading3">' +
    '<w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
    '<w:pPr><w:outlineLvl w:val="2"/><w:spacing w:before="180" w:after="100"/></w:pPr>' +
    '<w:rPr><w:b/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr>' +
    '</w:style>' +
    '<w:style w:type="paragraph" w:styleId="Caption">' +
    '<w:name w:val="Caption"/><w:basedOn w:val="Normal"/><w:qFormat/>' +
    '<w:pPr><w:jc w:val="center"/><w:spacing w:after="160"/></w:pPr>' +
    '<w:rPr><w:i/><w:color w:val="6B5B4A"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr>' +
    '</w:style>' +
    '<w:style w:type="character" w:styleId="Hyperlink">' +
    '<w:name w:val="Hyperlink"/>' +
    '<w:basedOn w:val="DefaultParagraphFont"/>' +
    '<w:rPr>' +
    '<w:color w:val="1155CC"/>' +
    '<w:u w:val="single"/>' +
    '</w:rPr>' +
    '</w:style>' +
    '</w:styles>'
  );
}

function buildSettingsXml(): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:settings xmlns:w="${WORD_MAIN_NAMESPACE}">` +
    '<w:zoom w:percent="100"/>' +
    '<w:defaultTabStop w:val="720"/>' +
    '<w:characterSpacingControl w:val="doNotCompress"/>' +
    '</w:settings>'
  );
}

function buildWebSettingsXml(): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:webSettings xmlns:w="${WORD_MAIN_NAMESPACE}">` +
    '<w:optimizeForBrowser/>' +
    '<w:allowPNG/>' +
    '</w:webSettings>'
  );
}

function buildAppXml(paragraphCount: number): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    '<Application>Evolutionary Web-Book Engine</Application>' +
    `<Paragraphs>${paragraphCount}</Paragraphs>` +
    '<DocSecurity>0</DocSecurity>' +
    '<ScaleCrop>false</ScaleCrop>' +
    '<LinksUpToDate>false</LinksUpToDate>' +
    '<SharedDoc>false</SharedDoc>' +
    '<HyperlinksChanged>false</HyperlinksChanged>' +
    '<AppVersion>1.0</AppVersion>' +
    '</Properties>'
  );
}

function buildCoreXml(webBook: WebBook, generatedAt: number): string {
  const created = toIsoTimestamp(webBook.timestamp || generatedAt);
  const modified = toIsoTimestamp(generatedAt);

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<cp:coreProperties xmlns:cp="${CORE_PROPS_NAMESPACE}" xmlns:dc="${DC_NAMESPACE}" xmlns:dcterms="${DCTERMS_NAMESPACE}" xmlns:dcmitype="${DCMITYPE_NAMESPACE}" xmlns:xsi="${XSI_NAMESPACE}">` +
    `<dc:title>${escapeXml(webBook.topic)}</dc:title>` +
    '<dc:creator>Codex</dc:creator>' +
    '<cp:lastModifiedBy>Codex</cp:lastModifiedBy>' +
    `<cp:keywords>${escapeXml('webbook, export, word')}</cp:keywords>` +
    `<dc:description>${escapeXml(getExportLabels(webBook).generatedBy)}</dc:description>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${modified}</dcterms:modified>` +
    '</cp:coreProperties>'
  );
}

function buildContentTypesXml(imageExtensions: string[]): string {
  const imageDefaults = Array.from(new Set(imageExtensions))
    .map((extension) => `<Default Extension="${escapeXml(extension)}" ContentType="${extension === 'png' ? 'image/png' : extension === 'gif' ? 'image/gif' : 'image/jpeg'}"/>`)
    .join('');

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    imageDefaults +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>' +
    '<Override PartName="/word/webSettings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.webSettings+xml"/>' +
    '</Types>'
  );
}

function buildPackageRelationshipsXml(): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="${PACKAGE_REL_NAMESPACE}">` +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
    '</Relationships>'
  );
}

function buildDocumentRelationshipsXml(relationships: string[]): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="${PACKAGE_REL_NAMESPACE}">` +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/webSettings" Target="webSettings.xml"/>' +
    relationships.join('') +
    '</Relationships>'
  );
}

export function buildWebBookDocx(
  webBook: WebBook,
  chapterImages: Array<DocxChapterImageAsset | null> = [],
): Uint8Array {
  nextBookmarkId = 1;

  const L = getExportLabels(webBook);
  const generatedAt = Date.now();
  const chapterRenderPlan = buildChapterRenderPlan(webBook.chapters, { sourceMode: webBook.sourceMode });
  const documentBlocks: string[] = [];
  const documentRelationships: string[] = [];
  const mediaFiles: Record<string, Uint8Array> = {};
  const imageExtensions: string[] = [];
  let nextRelationshipId = 4;
  let nextDrawingId = 1;

  const registerHyperlink = (url: string): string => {
    const relationshipId = `rId${nextRelationshipId}`;
    nextRelationshipId += 1;
    documentRelationships.push(
      `<Relationship Id="${relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${escapeXml(url)}" TargetMode="External"/>`,
    );
    return relationshipId;
  };

  const registerImage = (image: DocxChapterImageAsset): { fileName: string; relationshipId: string } => {
    const relationshipId = `rId${nextRelationshipId}`;
    nextRelationshipId += 1;
    const fileName = `image${Object.keys(mediaFiles).length + 1}.${image.extension}`;
    mediaFiles[`word/media/${fileName}`] = image.bytes;
    imageExtensions.push(image.extension);
    documentRelationships.push(
      `<Relationship Id="${relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${fileName}"/>`,
    );
    return { fileName, relationshipId };
  };

  documentBlocks.push(
    paragraph(bookmark('top', textRun(webBook.topic)), { alignment: 'center', spacingAfter: 160, style: 'Title' }),
    paragraph(textRun(L.engineName), { alignment: 'center', spacingAfter: 80, style: 'Subtitle' }),
    paragraph(textRun(`${L.generatedOn}${L.locale === 'en' ? ' ' : L.colon}${new Date(webBook.timestamp).toLocaleString(L.dateLocale)}`), { alignment: 'center', spacingAfter: 60, style: 'Subtitle' }),
    paragraph(textRun(L.chaptersAndSections(webBook.chapters.length, chapterRenderPlan.length), { mono: true, color: '6F6252', sizeHalfPoints: 18 }), { alignment: 'center', spacingAfter: 200 }),
    paragraph(textRun(''), { spacingAfter: 120 }),
    paragraph(textRun(L.tableOfContents), { style: 'Heading1', spacingAfter: 120 }),
  );

  chapterRenderPlan.forEach(({ chapter }, index) => {
    const heading = buildChapterHeading(chapter, index);
    const anchor = `chapter_${index + 1}`;
    documentBlocks.push(
      paragraph([
        textRun(`${heading.sequence}. `, { bold: true, mono: true, color: '6F6252' }),
        internalLink(anchor, heading.displayTitle),
        heading.facetLabel && heading.facetLabel.toLowerCase() !== heading.displayTitle.toLowerCase()
          ? textRun(`  ${heading.facetLabel}`, { color: '8A7B67', italic: true })
          : '',
      ], { keepLines: true, spacingAfter: 80 }),
    );
  });

  chapterRenderPlan.forEach(({ chapter, renderableDefinitions, renderableSubTopics }, index) => {
    const heading = buildChapterHeading(chapter, index);
    const anchor = `chapter_${index + 1}`;

    documentBlocks.push(
      pageBreak(),
      paragraph(
        bookmark(
          anchor,
          textRun(`${heading.sequence}  `, { bold: true, mono: true, color: '6F6252' }) +
          textRun(heading.displayTitle)
        ),
        { style: 'Heading1', keepLines: true, keepNext: true }
      ),
    );

    if (heading.facetLabel && heading.facetLabel.toLowerCase() !== heading.displayTitle.toLowerCase()) {
      documentBlocks.push(
        paragraph(textRun(heading.facetLabel, { italic: true, color: '8A7B67' }), { style: 'Subtitle', alignment: 'left', spacingAfter: 120 }),
      );
    }

    const chapterImage = chapterImages[index] || null;
    if (chapterImage) {
      const { fileName, relationshipId } = registerImage(chapterImage);
      documentBlocks.push(
        buildImageParagraph(
          relationshipId,
          fileName,
          chapterImage.altText,
          chapterImage.widthPx,
          chapterImage.heightPx,
          nextDrawingId,
        ),
      );
      nextDrawingId += 1;

      if (chapter.visualSeed?.trim()) {
        documentBlocks.push(
          paragraph(textRun(chapter.visualSeed.trim()), { style: 'Caption' }),
        );
      }
    }

    splitIntoParagraphs(chapter.content).forEach((paragraphText, paragraphIndex) => {
      documentBlocks.push(
        paragraph(
          textRun(paragraphText),
          {
            keepLines: paragraphText.length < 420,
            spacingAfter: paragraphIndex === 0 ? 180 : 160,
          },
        ),
      );
    });

    if (renderableSubTopics.length > 0) {
      documentBlocks.push(paragraph(textRun(L.deepAnalysis), { style: 'Heading2', keepNext: true }));
      renderableSubTopics.forEach((subTopic) => {
        documentBlocks.push(
          paragraph([
            textRun(`${subTopic.title}: `, { bold: true }),
            textRun(subTopic.summary),
          ], { keepLines: true, spacingAfter: 100 }),
        );
      });
    }

    if (renderableDefinitions.length > 0) {
      documentBlocks.push(paragraph(textRun(L.technicalGlossary), { style: 'Heading2', keepNext: true }));
      renderableDefinitions.forEach((definition) => {
        documentBlocks.push(
          paragraph([
            textRun(`${definition.term}: `, { bold: true, mono: true }),
            textRun(definition.description),
          ], { keepLines: definition.description.length < 320, spacingAfter: 100 }),
        );
      });
    }

    const sourceLinks = getChapterSourceLinks(chapter, { includeSearchResults: false, maxItems: 6 });
    if (sourceLinks.length > 0) {
      documentBlocks.push(paragraph(textRun(L.sources), { style: 'Heading2', keepNext: true }));
      sourceLinks.forEach((sourceLink) => {
        const relationshipId = registerHyperlink(sourceLink.url);
        documentBlocks.push(
          paragraph([
            textRun('- ', { bold: true }),
            `<w:hyperlink r:id="${relationshipId}" w:history="1">` +
            textRun(sourceLink.title, { color: '1155CC', bold: true }) +
            '</w:hyperlink>',
            textRun(` (${sourceLink.hostname})`, { color: '6F6252' }),
          ], { spacingAfter: 80 }),
        );
      });
    }
  });

  documentBlocks.push(
    paragraph(textRun(L.synthesisVerified), { style: 'Heading2', pageBreakBefore: true, keepNext: true }),
    paragraph(textRun(L.passCompleteDoc, { color: '6F6252' }), { spacingAfter: 100 }),
    paragraph(
      textRun(L.docNote),
      { spacingAfter: 120 }
    ),
    paragraph(
      internalLink('top', L.backToTop),
      { alignment: 'right', spacingBefore: 120 }
    ),
  );

  const documentXml = (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="${WORD_MAIN_NAMESPACE}" xmlns:r="${WORD_REL_NAMESPACE}" xmlns:wp="${WORD_DRAWING_NAMESPACE}" xmlns:a="${DRAWING_NAMESPACE}" xmlns:pic="${PICTURE_NAMESPACE}">` +
    '<w:body>' +
    documentBlocks.join('') +
    `<w:sectPr>` +
    `<w:pgSz w:w="${A4_PAGE_WIDTH_TWIPS}" w:h="${A4_PAGE_HEIGHT_TWIPS}"/>` +
    `<w:pgMar w:top="${PAGE_MARGIN_TWIPS}" w:right="${PAGE_MARGIN_TWIPS}" w:bottom="${PAGE_MARGIN_TWIPS}" w:left="${PAGE_MARGIN_TWIPS}" w:header="708" w:footer="708" w:gutter="0"/>` +
    `<w:cols w:space="${Math.round(0.25 * 1440)}"/>` +
    `<w:docGrid w:linePitch="${Math.round(0.25 * 1440)}"/>` +
    `</w:sectPr>` +
    '</w:body>' +
    '</w:document>'
  );

  const paragraphCount = (documentXml.match(/<w:p/g) || []).length;
  const entries: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(buildContentTypesXml(imageExtensions.length > 0 ? imageExtensions : ['jpeg'])),
    '_rels/.rels': strToU8(buildPackageRelationshipsXml()),
    'docProps/app.xml': strToU8(buildAppXml(paragraphCount)),
    'docProps/core.xml': strToU8(buildCoreXml(webBook, generatedAt)),
    'word/document.xml': strToU8(documentXml),
    'word/styles.xml': strToU8(buildStylesXml()),
    'word/settings.xml': strToU8(buildSettingsXml()),
    'word/webSettings.xml': strToU8(buildWebSettingsXml()),
    'word/_rels/document.xml.rels': strToU8(buildDocumentRelationshipsXml(documentRelationships)),
  };

  Object.entries(mediaFiles).forEach(([path, bytes]) => {
    entries[path] = bytes;
  });

  return zipSync(entries, { level: 6 });
}
