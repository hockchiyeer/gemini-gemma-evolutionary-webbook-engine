import assert from 'node:assert/strict';
import { exportWebBookWithJsPdf } from '../../src/services/exportService.ts';

console.log('Running CJK High-Res PDF export tests...');

// A CJK Web-book must come out of the High-Res (jsPDF editorial) export with its layout intact.
// It used to be rerouted to the reader-mode print export whenever the CJK font could not be fetched.
const sentence = '马来西亚政治格局和国家政治走向的深入分析，涵盖政府治理改革与公共服务提升。';
const cjkWebBook: any = {
  topic: '马来西亚政治格局 Malaysia Politics',
  timestamp: 1_700_000_000_000,
  sourceMode: 'gemini',
  chapters: [
    {
      title: '第一章：政治格局',
      content: `${sentence}\n\n${sentence}\n\n${sentence}`,
      visualSeed: 'parliament',
      definitions: [{ term: '团结政府', description: sentence, sourceUrl: 'https://example.com/unity' }],
      subTopics: [{ title: '改革议程', summary: sentence, sourceUrl: 'https://example.com/reform' }],
      sourceUrls: [{ title: '参考资料', url: 'https://example.com/ref' }],
    },
    {
      title: '第二章：国家走向',
      content: `${sentence}\n\n${sentence}`,
      visualSeed: 'nation',
      definitions: [],
      subTopics: [],
      sourceUrls: [{ title: 'Reference', url: 'https://example.org/ref' }],
    },
  ],
};

async function run(webBook: any): Promise<string> {
  let captured: Blob | undefined;
  const g = globalThis as any;
  const original = { createObjectURL: URL.createObjectURL, revokeObjectURL: URL.revokeObjectURL, document: g.document };
  URL.createObjectURL = ((blob: Blob) => {
    captured = blob;
    return 'blob:test';
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
  g.document = { createElement: () => ({ style: {}, click() {} }), body: { appendChild() {}, removeChild() {} } };
  try {
    await exportWebBookWithJsPdf(webBook, []);
  } finally {
    URL.createObjectURL = original.createObjectURL;
    URL.revokeObjectURL = original.revokeObjectURL;
    g.document = original.document;
  }
  assert.ok(captured, 'the High-Res export must hand a PDF blob to the download helper');
  return Buffer.from(await captured.arrayBuffer()).toString('latin1');
}

{
  const pdf = await run(cjkWebBook);
  assert.ok(pdf.startsWith('%PDF-') && pdf.trimEnd().endsWith('%%EOF'), 'valid PDF envelope');
  assert.ok(pdf.includes('/Identity-H'), 'CJK text must use the embedded Unicode (Identity-H) font');
  assert.ok(pdf.includes('/ToUnicode'), 'CJK text must be copyable/searchable (ToUnicode map)');
  assert.ok(pdf.includes('/FontFile2'), 'subset font must be embedded');
  const pageCount = (pdf.match(/\/Type\s*\/Page(?![s\w])/g) || []).length;
  assert.ok(pageCount >= 3, `High-Res layout has cover + TOC + chapter pages (got ${pageCount})`);
  const links = (pdf.match(/\/Subtype\s*\/Link/g) || []).length;
  assert.ok(links >= 3, `TOC jumps, Back to Top and source links must survive for CJK books (got ${links})`);
  console.log(`  ok  CJK book keeps the High-Res layout (${pageCount} pages, ${links} link annotations)`);
}

console.log('All CJK High-Res PDF export tests passed.');
