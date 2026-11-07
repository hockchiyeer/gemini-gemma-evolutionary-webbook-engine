import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildSync } from 'esbuild';
import { WebBookViewer } from '../../src/WebBookViewer.tsx';
import { exportWebBookWithJsPdf } from '../../src/services/exportService.ts';

console.log('Running focused hyperlink export tests...');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// ---------------------------------------------------------------------------
// Fixture: external URLs (including ones with (), \ and " that need PDF escaping)
// plus internal chapter fragments (TOC) and Back to Top.
// ---------------------------------------------------------------------------
const body =
  'Quantum computers use qubits that can exist in superpositions of states, enabling certain algorithms to outperform classical machines on specific problems.';
const EXTERNAL_URLS = [
  'https://en.wikipedia.org/wiki/Qubit_(quantum)?ref=a\\b', // parentheses + backslash
  'https://example.com/errors?x="q"&y=1', // double quotes
  'https://nature.com/articles/s41586-019-1666-5',
  'https://arxiv.org/abs/quant-ph/9508027',
];
const fixtureWebBook: any = {
  topic: 'Quantum Computing Basics',
  timestamp: 1_700_000_000_000,
  sourceMode: 'gemini',
  chapters: [
    {
      title: 'Quantum Foundations',
      content: `${body}\n\n${body}\n\n${body}`,
      visualSeed: 'qubit lattice',
      definitions: [{ term: 'Qubit', description: body, sourceUrl: EXTERNAL_URLS[0] }],
      subTopics: [{ title: 'Error Correction', summary: body, sourceUrl: EXTERNAL_URLS[1] }],
      sourceUrls: [{ title: 'Nature Quantum Article', url: EXTERNAL_URLS[2] }],
    },
    {
      title: 'Quantum Algorithms',
      content: `${body}\n\n${body}`,
      visualSeed: 'shor',
      definitions: [],
      subTopics: [],
      sourceUrls: [{ title: 'Shor paper', url: EXTERNAL_URLS[3] }],
    },
  ],
};

// ---------------------------------------------------------------------------
// Minimal PDF inspection helpers (no PDF library dependency). They read the
// real bytes of PDFs written by jsPDF and by Chrome (annotation dictionaries,
// the page tree and named destinations are stored as plain objects in both).
// ---------------------------------------------------------------------------
type PdfObjects = Map<number, string>;

function readObjects(pdf: string): PdfObjects {
  const objects: PdfObjects = new Map();
  for (const match of pdf.matchAll(/(?:^|\n)(\d+) 0 obj\s([\s\S]*?)endobj/g)) {
    objects.set(Number(match[1]), match[2]);
  }
  return objects;
}

function unescapePdfString(value: string): string {
  return value.replace(/\\([\\()])/g, '$1');
}

function pageObjectIds(objects: PdfObjects): number[] {
  const catalog = [...objects.values()].find((o) => /\/Type\s*\/Catalog/.test(o));
  assert.ok(catalog, 'PDF must have a catalog');
  const walk = (id: number): number[] => {
    const obj = objects.get(id)!;
    if (/\/Type\s*\/Pages/.test(obj)) {
      const kids = /\/Kids\s*\[([^\]]*)\]/.exec(obj)![1];
      return [...kids.matchAll(/(\d+) 0 R/g)].flatMap((k) => walk(Number(k[1])));
    }
    return [id];
  };
  return walk(Number(/\/Pages\s+(\d+) 0 R/.exec(catalog)![1]));
}

interface LinkInfo {
  page: number; // 1-based
  uri?: string;
  newWindow: boolean;
  hasJavaScript: boolean;
  hasAdditionalActions: boolean;
  destPage?: number; // 1-based page index of the internal destination
  destName?: string;
}

function namedDestinations(objects: PdfObjects, pages: number[]): Map<string, number> {
  const result = new Map<string, number>();
  const catalog = [...objects.values()].find((o) => /\/Type\s*\/Catalog/.test(o))!;
  const dests = /\/Dests\s+(\d+) 0 R/.exec(catalog);
  if (!dests) return result;
  for (const m of objects.get(Number(dests[1]))!.matchAll(/\/([^\s/[]+)\s*\[\s*(\d+) 0 R/g)) {
    result.set(m[1], pages.indexOf(Number(m[2])) + 1);
  }
  return result;
}

function skipPdfString(text: string, index: number): number {
  let depth = 0;
  for (let i = index; i < text.length; i += 1) {
    if (text[i] === '\\') i += 1;
    else if (text[i] === '(') depth += 1;
    else if (text[i] === ')' && --depth === 0) return i + 1;
  }
  return text.length;
}

// A page's /Annots entries: inline dictionaries (jsPDF) and/or indirect references (Chrome).
function annotationBodies(objects: PdfObjects, pageBody: string): string[] {
  const at = pageBody.indexOf('/Annots');
  if (at < 0) return [];
  let text = pageBody;
  let i = pageBody.indexOf('[', at);
  const indirect = /\/Annots\s+(\d+) 0 R/.exec(pageBody);
  if (indirect) {
    text = objects.get(Number(indirect[1]))!;
    i = text.indexOf('[');
  }
  const bodies: string[] = [];
  let arrayDepth = 0;
  let dictDepth = 0;
  let dictStart = 0;
  for (; i < text.length; i += 1) {
    const c = text[i];
    if (c === '(') i = skipPdfString(text, i) - 1;
    else if (c === '<' && text[i + 1] === '<') {
      if (dictDepth++ === 0) dictStart = i;
      i += 1;
    } else if (c === '>' && text[i + 1] === '>') {
      i += 1;
      if (--dictDepth === 0) bodies.push(text.slice(dictStart, i + 1));
    } else if (c === '[') arrayDepth += 1;
    else if (c === ']' && --arrayDepth === 0) break;
    else if (dictDepth === 0 && arrayDepth === 1 && /\d/.test(c) && !/\d/.test(text[i - 1])) {
      const ref = /^(\d+) 0 R/.exec(text.slice(i));
      if (ref) {
        bodies.push(objects.get(Number(ref[1]))!);
        i += ref[0].length - 1;
      }
    }
  }
  return bodies;
}

function readLinks(pdf: string): { links: LinkInfo[]; pages: number[]; objects: PdfObjects } {
  const objects = readObjects(pdf);
  const pages = pageObjectIds(objects);
  const names = namedDestinations(objects, pages);
  const links: LinkInfo[] = [];
  pages.forEach((pageId, pageIndex) => {
    for (const annot of annotationBodies(objects, objects.get(pageId)!)) {
      if (!/\/Subtype\s*\/Link/.test(annot)) continue;
      const uri = /\/S\s*\/URI\b/.test(annot) ? /\/URI\s*\(((?:\\.|[^\\)])*)\)/.exec(annot) : null;
      const info: LinkInfo = {
        page: pageIndex + 1,
        uri: uri ? unescapePdfString(uri[1]) : undefined,
        newWindow: /\/NewWindow\s+true/.test(annot),
        hasJavaScript: /\/JavaScript|\/JS\b/.test(annot),
        hasAdditionalActions: /\/AA\b/.test(annot),
      };
      const dest = /\/Dest\s*(?:\[\s*(\d+) 0 R|\/([^\s/>\]]+))/.exec(annot);
      if (dest?.[1]) info.destPage = pages.indexOf(Number(dest[1])) + 1;
      if (dest?.[2]) {
        info.destName = dest[2];
        info.destPage = names.get(dest[2]);
      }
      links.push(info);
    }
  });
  return { links, pages, objects };
}

function assertXrefValid(pdf: string): void {
  const startxref = /startxref\s+(\d+)/.exec(pdf);
  assert.ok(startxref, 'PDF must contain a startxref pointer');
  const xrefOffset = Number(startxref[1]);
  assert.equal(pdf.substring(xrefOffset, xrefOffset + 4), 'xref', 'startxref must point at the xref table');
  const lines = pdf.substring(xrefOffset).split('\n');
  const count = Number(lines[1].split(' ')[1]);
  for (let id = 1; id < count; id += 1) {
    const offset = Number(lines[2 + id].split(' ')[0]);
    assert.ok(pdf.substring(offset).startsWith(`${id} 0 obj`), `xref entry ${id} must point at "${id} 0 obj"`);
  }
}

// ---------------------------------------------------------------------------
// 1. High Res PDF (EXPORT > PDF DOCUMENT) - real exportWebBookWithJsPdf output
// ---------------------------------------------------------------------------
async function generateHighResPdf(): Promise<string> {
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
    await exportWebBookWithJsPdf(fixtureWebBook, []);
  } finally {
    URL.createObjectURL = original.createObjectURL;
    URL.revokeObjectURL = original.revokeObjectURL;
    g.document = original.document;
  }
  assert.ok(captured, 'exportWebBookWithJsPdf must hand a PDF blob to the download helper');
  return Buffer.from(await captured.arrayBuffer()).toString('latin1');
}

{
  const pdf = await generateHighResPdf();
  const { links, pages, objects } = readLinks(pdf);

  const external = links.filter((l) => l.uri !== undefined);
  const internal = links.filter((l) => l.uri === undefined);

  // External: every URL is a real /S /URI action, destination preserved byte-for-byte, flag present.
  assert.deepEqual(
    external.map((l) => l.uri).sort(),
    [...EXTERNAL_URLS].sort(),
    'Every external URL (including ones with parentheses, backslashes and quotes) must be preserved exactly'
  );
  for (const link of external) {
    assert.ok(link.newWindow, `External link ${link.uri} must carry /NewWindow true`);
    assert.ok(!link.hasJavaScript && !link.hasAdditionalActions, `External link ${link.uri} must not carry JavaScript or /AA actions`);
  }

  // Internal: 2 TOC chapter jumps + 1 Back to Top, pure /Dest, no actions or flags.
  assert.equal(internal.length, 3, 'Expected 2 TOC chapter links and 1 Back to Top link');
  for (const link of internal) {
    assert.ok(!link.newWindow && !link.hasJavaScript && !link.hasAdditionalActions, 'Internal links must have no new-window/JS/AA actions');
  }
  const [toc1, toc2] = internal.filter((l) => l.page === 2);
  const [backToTop] = internal.filter((l) => l.page !== 2);
  assert.ok(toc1 && toc2 && backToTop, 'Two TOC links live on page 2; Back to Top lives on the last chapter page');
  assert.equal(backToTop.destPage, 1, 'Back to Top must jump to page 1 of the same document');
  const pageText = (pageNumber: number) => objects.get(pages[pageNumber - 1])!;
  const contentOf = (pageNumber: number) => {
    const ref = /\/Contents\s+(\d+) 0 R/.exec(pageText(pageNumber))![1];
    return objects.get(Number(ref))!;
  };
  assert.ok(contentOf(toc1.destPage!).includes('Quantum Foundations'), 'TOC link 1 must land on the Quantum Foundations page');
  assert.ok(contentOf(toc2.destPage!).includes('Quantum Algorithms'), 'TOC link 2 must land on the Quantum Algorithms page');
  assert.ok(!pdf.includes('/JavaScript'), 'High Res PDF must not embed JavaScript actions');

  // Serialization stays valid.
  assertXrefValid(pdf);
  assert.ok(pdf.startsWith('%PDF-') && pdf.trimEnd().endsWith('%%EOF'), 'PDF header and trailer must be intact');
  console.log(`  ok  High Res PDF: ${external.length} external links flagged, ${internal.length} internal links untouched, xref valid`);
}

// ---------------------------------------------------------------------------
// 2. Interactive HTML WebBook - real WebBookViewer markup
// ---------------------------------------------------------------------------
const viewerHtml = renderToStaticMarkup(React.createElement(WebBookViewer, { webBook: fixtureWebBook }));
const anchors = [...viewerHtml.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]);
const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

{
  const external = anchors.filter((a) => /^https?:\/\//.test(attr(a, 'href') ?? ''));
  const internal = anchors.filter((a) => (attr(a, 'href') ?? '').startsWith('#'));
  assert.equal(external.length + internal.length, anchors.length, 'Every anchor must be classified as external or internal');
  assert.ok(external.length >= EXTERNAL_URLS.length, 'Fixture external links must be rendered');
  for (const a of external) {
    assert.equal(attr(a, 'target'), '_blank', `External link must open in a new tab: ${a}`);
    assert.match(attr(a, 'rel') ?? '', /noopener/, `External link must carry rel=noopener: ${a}`);
  }
  const internalHrefs = internal.map((a) => attr(a, 'href'));
  assert.deepEqual(internalHrefs, ['#chapter-0', '#chapter-1', '#top'], 'TOC chapter links and Back to Top must keep their fragment hrefs');
  for (const a of internal) assert.equal(attr(a, 'target'), '_self', `Internal link must stay in the same tab: ${a}`);
  for (const id of ['chapter-0', 'chapter-1', 'top']) {
    assert.ok(viewerHtml.includes(`id="${id}"`), `Internal destination id="${id}" must exist in the WebBook`);
  }
  console.log(`  ok  Interactive HTML: ${external.length} external links open in a new tab, ${internal.length} internal links stay internal`);
}

// ---------------------------------------------------------------------------
// 3. Print / Save As PDF - real PDF produced by Chrome from the real print shell
//    Needs a local Chrome/Chromium; set CHROME_PATH (and optionally CHROME_FLAGS).
//    Skipped (loudly) when none is available.
// ---------------------------------------------------------------------------
function findChrome(): string | undefined {
  const candidates = [
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ];
  return candidates.find((c): c is string => Boolean(c) && existsSync(c as string));
}

const chrome = findChrome();
if (!chrome) {
  console.log('  SKIP Print / Save As PDF: no Chrome/Chromium found (set CHROME_PATH to run the real-PDF check)');
} else {
  const work = mkdtempSync(path.join(tmpdir(), 'webbook-print-'));
  try {
    // Bundle the real exportDocument.ts so the real prepareExportContent + print shell run inside Chrome's DOM.
    const bundle = buildSync({
      stdin: {
        contents: "import { prepareExportContent, buildPrintHtmlDocument } from './src/services/exportDocument.ts'; window.__exp = { prepareExportContent, buildPrintHtmlDocument };",
        resolveDir: repoRoot,
        loader: 'ts',
      },
      bundle: true,
      format: 'iife',
      write: false,
    }).outputFiles[0].text;
    writeFileSync(path.join(work, 'bundle.js'), bundle);
    writeFileSync(
      path.join(work, 'page.html'),
      `<!doctype html><html><body>${viewerHtml}<script src="bundle.js"></script><script>
        (async () => {
          const { clone } = await window.__exp.prepareExportContent(document.querySelector('.web-book-container'), { inlineImages: false });
          // Drop network-only tags (Tailwind CDN, Google Fonts) so the check is hermetic; links are unaffected.
          const html = window.__exp.buildPrintHtmlDocument({ topic: 'Quantum Computing Basics' }, clone.outerHTML)
            .replace(/<script[\\s\\S]*?<\\/script>/g, '').replace(/<link[^>]*>/g, '');
          const shell = new DOMParser().parseFromString(html, 'text/html');
          document.head.replaceChildren(...shell.head.childNodes);
          document.body.replaceChildren(...shell.body.childNodes);
        })();
      </script></body></html>`
    );
    const pdfPath = path.join(work, 'print.pdf');
    const flags = (process.env.CHROME_FLAGS ?? '--no-sandbox --disable-gpu').split(/\s+/).filter(Boolean);
    const run = spawnSync(
      chrome,
      ['--headless', ...flags, '--no-pdf-header-footer', '--virtual-time-budget=15000', `--print-to-pdf=${pdfPath}`, `file://${path.join(work, 'page.html')}`],
      { encoding: 'utf8', timeout: 90_000 }
    );
    assert.ok(existsSync(pdfPath), `Chrome must write a PDF (status ${run.status}): ${run.stderr?.slice(0, 300)}`);

    const pdf = readFileSync(pdfPath).toString('latin1');
    const { links } = readLinks(pdf);
    const external = links.filter((l) => l.uri !== undefined);
    const internal = links.filter((l) => l.uri === undefined);

    // Chrome writes canonical URLs, so compare against the WHATWG-normalised form of each fixture URL.
    assert.deepEqual(
      [...new Set(external.map((l) => l.uri))].sort(),
      [...new Set(EXTERNAL_URLS.map((u) => new URL(u).href))].sort(),
      'Printed PDF must keep every external destination URL'
    );
    for (const link of external) {
      assert.ok(!link.hasJavaScript, 'Printed PDF external links must not contain JavaScript');
    }
    // Internal navigation must survive printing as named destinations on the correct pages.
    assert.deepEqual(
      internal.map((l) => l.destName),
      ['chapter-0', 'chapter-1', 'top'],
      'TOC chapter links and Back to Top must remain internal named destinations'
    );
    assert.equal(internal[2].destPage, 1, 'Back to Top must resolve to page 1 of the printed document');
    assert.ok(internal[0].destPage! > 2 && internal[1].destPage! > internal[0].destPage!, 'TOC links must resolve to chapter pages in order');
    for (const link of internal) assert.ok(!link.newWindow && !link.hasJavaScript, 'Internal printed links must carry no new-window/JS actions');

    // Documented limitation, asserted so a Chrome change that starts preserving it is noticed:
    // Chrome serialises <a target="_blank"> as a plain /S /URI action with no new-window flag.
    assert.ok(external.every((l) => !l.newWindow), 'Chrome print output is expected to carry no new-window flag (native limitation)');
    console.log(`  ok  Print / Save As PDF (real Chrome PDF): ${external.length} external URI links, ${internal.length} internal named-destination links; Chrome emits no new-window flag`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

console.log('hyperlinkExport regression tests passed successfully!');
