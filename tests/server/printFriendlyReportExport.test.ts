import assert from 'node:assert/strict';
import {
  buildPrintFriendlyReportHtml,
  buildPrintFriendlyReportPagesHtml,
  exportPrintFriendlyWebBookToImage,
  exportPrintFriendlyWebBookToPdf,
  paginateBlockHeights,
} from '../../src/services/printFriendlyReportExport.ts';
import type { Chapter, WebBook } from '../../src/types.ts';

console.log('Running printFriendlyReportExport regression tests...');

const sentence = 'Quantum field dynamics describe interacting excitations across coupled domains. ';
const longNarrative = Array.from({ length: 4 }, (_, p) => `Paragraph ${p + 1} marker. ${sentence.repeat(14)}END-OF-PARAGRAPH-${p + 1}`).join('\n\n');
const makeChapters = (count: number): Chapter[] =>
  Array.from({ length: count }, (_, i) => ({
    title: `Chapter ${i + 1} ${'with a deliberately long descriptive title '.repeat(2)}`.trim(),
    content: longNarrative,
    definitions: Array.from({ length: 5 }, (_, d) => ({
      term: `Term ${i + 1}.${d + 1}`,
      description: `Definition body ${i + 1}.${d + 1} ${'extended explanatory wording '.repeat(8)}FULL-DEF-${i + 1}-${d + 1}`,
      sourceUrl: 'https://example.com',
    })),
    subTopics: Array.from({ length: 5 }, (_, t) => ({
      title: `Dimension ${i + 1}.${t + 1}`,
      summary: `Dimension body ${i + 1}.${t + 1} ${'extended explanatory wording '.repeat(8)}FULL-SUB-${i + 1}-${t + 1}`,
      sourceUrl: 'https://example.com',
    })),
    sourceUrls: ['https://example.com', 'https://example.org', 'https://example.net'],
    visualSeed: `seed ${i + 1}`,
  }));

const longBook: WebBook = { id: 'test-long', topic: 'Long Form Topic', timestamp: 1_700_000_000_000, chapters: makeChapters(6) };

// 1. Print (PDF) document: reader-mode typography, semantic structure, complete text, no screenshot-style micro type
{
  const html = buildPrintFriendlyReportHtml(longBook);
  assert.ok(html.startsWith('<!doctype html>'), 'Must be a standalone HTML document');
  assert.ok(html.includes('<title>Long Form Topic</title>'), 'Document title drives the suggested PDF file name');
  assert.ok(html.includes('<h1>Long Form Topic</h1>'), 'Topic is the h1');
  assert.equal((html.match(/<h2>/g) || []).length, 6, 'Each chapter is an h2');
  assert.ok(html.includes('font-size: 16px') && html.includes('line-height: 1.7'), 'Body text must be 16px (12pt) with 1.7 leading');
  assert.ok(!/text-align:\s*justify/.test(html), 'Body text must be left-aligned, never justified');
  assert.ok(!/font-size:\s*(?:[0-9]|1[0-1])(?:\.\d+)?px/.test(html), 'No text may be smaller than 12px');
  assert.ok(!/JetBrains|Playfair|font-style:\s*italic/.test(html), 'No monospace/decorative/italic display faces');
  assert.ok(!html.includes('fonts.googleapis.com'), 'No external web fonts: the document must render offline');
  assert.ok(html.includes('size: A4'), 'Print stylesheet must target A4');
  assert.ok(html.includes('counter(page)'), 'Print stylesheet must number pages');
  assert.ok(!html.includes('Domain terminology integrated in narrative'), 'Placeholder filler text must not be emitted');
  assert.ok(html.includes('<a href="https://example.com/">example.com</a>'), 'Sources must be real links');
  for (let i = 1; i <= 6; i += 1) {
    assert.ok(html.includes(`<h2>${i}. Chapter ${i} `), `Chapter ${i} heading present`);
    for (let d = 1; d <= 5; d += 1) {
      assert.ok(html.includes(`FULL-DEF-${i}-${d}`), `Definition ${i}.${d} shown in full`);
      assert.ok(html.includes(`FULL-SUB-${i}-${d}`), `Sub-topic ${i}.${d} shown in full`);
    }
  }
  assert.equal(html.split('END-OF-PARAGRAPH-4').length - 1, 6, 'Each paragraph appears exactly once');
  assert.ok(!html.includes('...'), 'No truncated text');
  assert.ok(html.includes('Evolutionary Synthesis &amp; Evidence Verification'), 'Conclusion note present');

  const cjk = buildPrintFriendlyReportHtml({ ...longBook, topic: '台北市長選舉 2026' });
  assert.ok(cjk.includes('lang="zh"'), 'CJK topics get a CJK lang attribute so the right glyph set is used');

  const escaped = buildPrintFriendlyReportHtml({ ...longBook, topic: 'A <script>alert(1)</script> & B' });
  assert.ok(!escaped.includes('<script>alert(1)</script>'), 'Topic must be HTML-escaped');
}

// 1b. Over-long query-derived topics: the cover shows a complete summarized title, never a mid-word cut
{
  const longTopic =
    "AI's biggest drivers and sources of revenue are cloud infrastructure, cloud services, energy, real estate, " +
    'semiconductors, AI chips, and hardware peripherals, networking and cooling systems';
  const book: WebBook = { ...longBook, topic: longTopic };
  const html = buildPrintFriendlyReportHtml(book);
  const decode = (value: string) => value.replace(/&#0?39;|&#x27;/g, "'").replace(/&amp;/g, '&');
  const cover = decode(/<h1 class="pf-cover-title">([^<]*)<\/h1>/.exec(html)?.[1] ?? '');
  assert.ok(cover.endsWith('…') && cover.length <= 90, 'PDF cover title is summarized to fit');
  assert.ok(longTopic.startsWith(cover.slice(0, -1)), 'PDF cover title is a clean prefix of the topic');
  assert.ok(!/,\s*n…?$/.test(cover), 'No half-word remains on the cover');
  const imageCover = buildPrintFriendlyReportPagesHtml(book)[0];
  assert.ok(decode(imageCover).includes(`${cover}</h1>`), 'JPG cover uses the same summarized title');
}

// 2. Image pages: complete content, one A4 page per image, stable numbering
{
  const pages = buildPrintFriendlyReportPagesHtml(longBook);
  assert.ok(pages.length > 2, 'Full-length text must flow onto several A4 pages');
  const all = pages.join('\n');
  assert.ok(all.includes('width: 794px') && all.includes('height: 1123px'), 'Pages are A4 at 96dpi (794x1123)');
  for (let i = 1; i <= 6; i += 1) {
    for (let p = 1; p <= 4; p += 1) assert.ok(all.includes(`END-OF-PARAGRAPH-${p}`), `Paragraph ${p} present`);
    for (let d = 1; d <= 5; d += 1) {
      assert.ok(all.includes(`FULL-DEF-${i}-${d}`));
      assert.ok(all.includes(`FULL-SUB-${i}-${d}`));
    }
  }
  assert.equal(all.split('END-OF-PARAGRAPH-4').length - 1, 6, 'No duplicated or dropped text');
  pages.forEach((page, index) => assert.ok(page.includes(`Page ${index + 1} of ${pages.length}`), 'Footer carries correct numbering'));
  assert.ok(pages[pages.length - 1].includes('Evidence Verification'), 'Conclusion on the last page');
  assert.ok(!/font-size:\s*(?:[0-9]|1[0-1])(?:\.\d+)?px/.test(all), 'No text smaller than 12px on image pages');

  // Smaller measured heights pack tighter; larger ones add pages but never lose content
  const blockCount = (all.match(/class="pf-blk"/g) || []).length;
  const tiny = buildPrintFriendlyReportPagesHtml(longBook, Array(blockCount).fill(10));
  const huge = buildPrintFriendlyReportPagesHtml(longBook, Array(blockCount).fill(400));
  assert.ok(tiny.length < pages.length && huge.length > pages.length);
  assert.ok(huge.join('\n').includes('FULL-SUB-6-5'), 'Taller blocks must keep all content');

  // A very long paragraph is split without losing a single word
  const hugeParagraph = 'zqx '.repeat(3000).trim();
  const hugeBook: WebBook = { ...longBook, chapters: [{ ...makeChapters(1)[0], content: hugeParagraph }] };
  const hugePages = buildPrintFriendlyReportPagesHtml(hugeBook).join('\n');
  assert.equal((hugePages.match(/\bzqx\b/g) || []).length, 3000, 'Oversized paragraph preserved word-for-word');
}

// 3. Pagination rules
{
  // 3 blocks of 400 in a 900px page: third wraps
  assert.deepEqual(paginateBlockHeights([400, 400, 400], [false, false, false], 900), [[0, 1], [2]]);
  // A heading is never stranded at the bottom of a page: it moves with the block that follows it
  assert.deepEqual(paginateBlockHeights([700, 50, 300], [false, true, false], 900), [[0], [1, 2]]);
  // A block taller than a page is kept (on its own page), never dropped
  assert.deepEqual(paginateBlockHeights([2000, 100], [false, false], 900), [[0], [1]]);
  assert.deepEqual(paginateBlockHeights([], [], 900), [[]]);
}

// 4. Export execution in a headless Node environment (no DOM => raster PDF fallback, per-page JPG download)
{
  const downloads: Array<{ blob: Blob; name: string }> = [];
  const g = globalThis as any;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const originalDocument = g.document;
  let pendingName = '';

  URL.createObjectURL = ((blob: Blob) => {
    downloads.push({ blob, name: '' });
    return 'blob:mock-print-friendly';
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;

  g.document = {
    createElement: (tag: string) =>
      tag === 'a'
        ? {
            style: {},
            click: () => {
              downloads[downloads.length - 1].name = pendingName;
            },
            set download(val: string) {
              pendingName = val;
            },
          }
        : { style: {} },
    body: { appendChild: () => {}, removeChild: () => {} },
  };

  const sampleBook: WebBook = {
    id: 'test-exec',
    topic: 'Minimal Export Verification',
    timestamp: 1_700_000_000_000,
    chapters: [
      {
        title: 'Single Chapter',
        content: 'Verification narrative content.',
        definitions: [],
        subTopics: [],
        sourceUrls: [],
        visualSeed: 'Single Chapter',
      },
    ],
  };

  try {
    await exportPrintFriendlyWebBookToPdf(sampleBook);
    assert.equal(downloads.length, 1, 'PDF export falls back to a download when printing is unavailable');
    assert.ok(downloads[0].name.endsWith('_PrintFriendly_Report.pdf'));

    downloads.length = 0;
    await exportPrintFriendlyWebBookToImage(sampleBook);
    assert.equal(downloads.length, 1, 'A single-page report downloads exactly one JPG');
    assert.ok(downloads[0].name.endsWith('_PrintFriendly_Report.jpg'));
  } finally {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    g.document = originalDocument;
  }
}

console.log('All printFriendlyReportExport regression tests passed.');
