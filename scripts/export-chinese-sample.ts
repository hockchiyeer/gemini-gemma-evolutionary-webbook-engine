import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { exportWebBookWithJsPdf } from '../src/services/exportService';
import { buildWebBookDocx } from '../src/services/docxExport';
import {
  buildStandaloneHtmlDocument,
  buildPrintHtmlDocument,
  getExportFileName,
} from '../src/services/exportDocument';
import { buildPrintFriendlyReportPagesHtml } from '../src/services/printFriendlyReportExport';
import { getExportLabels } from '../src/services/exportLabels';
import { getChapterSourceLinks, sanitizeWebBookForPresentation } from '../src/utils/webBookRender';
import { WebBookViewer } from '../src/WebBookViewer';
import type { WebBook } from '../src/types';

const sentence = '马来西亚政治格局和国家政治走向的深入分析，涵盖政府治理改革与公共服务提升。';
const cjkWebBook: WebBook = {
  topic: '马来西亚政治格局 Malaysia Politics',
  timestamp: 1_700_000_000_000,
  sourceMode: 'gemini',
  generationNotice: 'Generated via Gemini with Google Search grounding.',
  chapters: [
    {
      title: '第一章：政治格局演变与多党联盟',
      content: `${sentence}\n\n${sentence}\n\n${sentence}`,
      visualSeed: 'parliament building with geometric light',
      definitions: [
        { term: '团结政府', description: '在无单一政党过半情况下，由多个政党联盟协商共组的执政架构。', sourceUrl: 'https://example.com/unity-gov' },
        { term: '反跳槽法', description: '旨在遏制议员随意退党或更换阵营以维护议会稳定的法案。', sourceUrl: 'https://example.com/anti-hopping' },
      ],
      subTopics: [
        { title: '跨党派合作协议', summary: '朝野阵营就关键立法、财政预算与改革议程签订谅解备忘录，以保障政府稳定运作。', sourceUrl: 'https://example.com/mou-reform' },
        { title: '公服体系数字化与廉政', summary: '通过电子政务与阳光法案提升治理透明度，降低权力寻租空间。', sourceUrl: 'https://example.com/digital-gov' },
      ],
      sourceUrls: [
        { title: '马来西亚选举制度改革研究', url: 'https://example.com/election-reform' },
        { title: '当代东南亚国家治理分析报告', url: 'https://example.com/asean-governance' },
      ],
    },
    {
      title: '第二章：制度改革与经济社会治理',
      content: `${sentence}\n\n${sentence}`,
      visualSeed: 'institutional governance framework',
      definitions: [
        { term: '财政责任法案', description: '约束政府赤字与债务上限以确保长期财政健康的法律制度。', sourceUrl: 'https://example.com/fiscal-act' },
      ],
      subTopics: [
        { title: '补贴合理化机制', summary: '从普惠式燃油与民生补贴转向精准针对低收入群体的靶向补贴体系。', sourceUrl: 'https://example.com/targeted-subsidy' },
      ],
      sourceUrls: [
        { title: '马来西亚经济与财政转型年度报告', url: 'https://example.com/fiscal-review' },
      ],
    },
    {
      title: '第三章：外交定位与未来战略展望',
      content: `${sentence}\n\n${sentence}`,
      visualSeed: 'asean multilateral summit hall',
      definitions: [],
      subTopics: [
        { title: '东盟中心地位与大国平衡', summary: '坚持不结盟与中立原则，在中美及全球多极博弈中维护国家战略自主。', sourceUrl: 'https://example.com/asean-neutrality' },
      ],
      sourceUrls: [
        { title: '东盟地缘政治与经济合作白皮书', url: 'https://example.com/geopolitics-whitepaper' },
      ],
    },
  ],
};

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

async function main() {
  const safeWebBook = sanitizeWebBookForPresentation(cjkWebBook);
  const L = getExportLabels(safeWebBook);

  const outDir = path.resolve('exports');
  fs.mkdirSync(outDir, { recursive: true });

  const artifactDir = '/.aistudio/artifacts/brain/b948116b-bccc-4135-810e-6ce265fdcee6';
  try { fs.mkdirSync(artifactDir, { recursive: true }); } catch {}

  const saveFile = (filename: string, buffer: Buffer | Uint8Array | string) => {
    const localPath = path.join(outDir, filename);
    fs.writeFileSync(localPath, buffer);
    console.log(`Saved: ${localPath} (${Buffer.byteLength(buffer)} bytes)`);
    try {
      const artPath = path.join(artifactDir, filename);
      fs.writeFileSync(artPath, buffer);
      console.log(`Saved artifact: ${artPath}`);
    } catch {}
  };

  // Sample chapter image for Chapter 1
  const dummyPngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const chapterImages = [
    {
      bytes: dummyPngBytes,
      extension: 'png' as const,
      altText: '马来西亚国会大厦概念图',
      widthPx: 800,
      heightPx: 450,
    },
    null,
    null,
  ];

  // 1. Plain Text (.txt)
  let text = `${safeWebBook.topic.toUpperCase()}\n`;
  text += `${L.generatedOn}${L.colon}${new Date(safeWebBook.timestamp).toLocaleString(L.dateLocale)}\n\n`;
  safeWebBook.chapters.forEach((chapter, index) => {
    const chapterHeading = `${L.upper(L.chapter(index + 1))}${L.colon}${chapter.title}`;
    text += `${chapterHeading}\n`;
    text += `${'='.repeat(getTextVisualWidth(chapterHeading))}\n\n`;
    text += `${chapter.content}\n\n`;
    if (chapter.visualSeed?.trim()) {
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
  saveFile(getExportFileName(safeWebBook.topic, 'txt'), text);

  // 2. Word Document (.docx)
  const docxBytes = buildWebBookDocx(safeWebBook, chapterImages);
  saveFile(getExportFileName(safeWebBook.topic, 'docx'), docxBytes);

  // 3. High-Res jsPDF (.pdf)
  let pdfBuffer: Buffer | null = null;
  const g = globalThis as any;
  const original = { createObjectURL: URL.createObjectURL, revokeObjectURL: URL.revokeObjectURL, document: g.document };
  URL.createObjectURL = ((blob: Blob) => {
    blob.arrayBuffer().then((buf) => {
      pdfBuffer = Buffer.from(buf);
    });
    return 'blob:capture_pdf';
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
  g.document = { createElement: () => ({ style: {}, click() {} }), body: { appendChild() {}, removeChild() {} } };

  try {
    await exportWebBookWithJsPdf(safeWebBook, chapterImages);
  } finally {
    URL.createObjectURL = original.createObjectURL;
    URL.revokeObjectURL = original.revokeObjectURL;
    g.document = original.document;
  }

  // Allow promise to resolve
  await new Promise((r) => setTimeout(r, 100));
  if (pdfBuffer) {
    saveFile(getExportFileName(safeWebBook.topic, 'pdf'), pdfBuffer);
  }

  // 4. Standalone HTML (with real WebBookViewer component markup)
  const readerMarkup = renderToStaticMarkup(React.createElement(WebBookViewer, { webBook: safeWebBook }));
  const htmlDoc = buildStandaloneHtmlDocument(safeWebBook, readerMarkup);
  saveFile(getExportFileName(safeWebBook.topic, 'html'), htmlDoc);

  // 5. Print-Friendly Report HTML
  const printPages = buildPrintFriendlyReportPagesHtml(safeWebBook);
  const printDoc = buildPrintHtmlDocument(safeWebBook, printPages.join('\n'));
  saveFile(`${safeWebBook.topic.replace(/\s+/g, '_')}_print_friendly.html`, printDoc);

  console.log('All sample exports generated successfully.');
}

main().catch(console.error);
