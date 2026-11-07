import { getExportLabels } from './exportLabels';
import type { WebBook } from '../types';
import type { DocxChapterImageAsset } from './docxExport';
import { getWebBookDocumentTitle } from './documentTitle';

const EXPORT_CLEANUP_SELECTOR = 'button, .print\\:hidden, [data-html2canvas-ignore]';
const EXPORT_FONT_LINKS = '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;700&family=Playfair+Display:ital,wght@0,400;0,700;1,400;1,700&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">';
const EXPORT_RENDER_READY_SCRIPT = `
  (() => {
    const markReady = () => {
      const finalize = () => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            document.documentElement.dataset.renderReady = 'true';
          });
        });
      };

      if ('fonts' in document && document.fonts?.ready) {
        document.fonts.ready.then(finalize).catch(finalize);
        return;
      }

      finalize();
    };

    if (document.readyState === 'complete') {
      markReady();
      return;
    }

    window.addEventListener('load', markReady, { once: true });
  })();
`;

export interface PreparedExportContent {
  clone: HTMLElement;
  chapterImages: Array<DocxChapterImageAsset | null>;
}

interface PrepareExportContentOptions {
  inlineImages?: boolean;
}

export function getWebBookElement(): HTMLElement {
  const element = document.querySelector('.web-book-container') as HTMLElement | null;
  if (!element) {
    throw new Error('No rendered Web-book was found to export.');
  }

  return element;
}

export function getExportFileName(topic: string, extension: string): string {
  return `${topic.replace(/\s+/g, '_')}.${extension}`;
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.style.display = 'none';
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

function parseDataUrlImage(src: string): DocxChapterImageAsset | null {
  const match = /^data:(image\/(?:jpeg|png|gif));base64,(.+)$/i.exec(src);
  if (!match) return null;

  const [, rawContentType, base64Payload] = match;
  const contentType = rawContentType.toLowerCase() as DocxChapterImageAsset['contentType'];
  const extension = contentType === 'image/png'
    ? 'png'
    : contentType === 'image/gif'
      ? 'gif'
      : 'jpeg';

  const binary = window.atob(base64Payload);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return {
    altText: '',
    bytes,
    contentType,
    extension,
    widthPx: 1,
    heightPx: 1,
  };
}

function collectWordChapterImages(root: HTMLElement): Array<DocxChapterImageAsset | null> {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-pdf-page-kind="chapter"]'))
    .map((chapterSection) => {
      const image = chapterSection.querySelector<HTMLImageElement>('img');
      if (!image?.src) return null;

      const parsed = parseDataUrlImage(image.src);
      if (!parsed) return null;

      const exportedWidth = Number(image.dataset.exportWidth || image.dataset.exportOriginalWidth || image.naturalWidth || image.width || 0);
      const exportedHeight = Number(image.dataset.exportHeight || image.dataset.exportOriginalHeight || image.naturalHeight || image.height || 0);

      return {
        ...parsed,
        altText: image.alt || 'Chapter image',
        widthPx: Math.max(1, Math.round(exportedWidth || 1)),
        heightPx: Math.max(1, Math.round(exportedHeight || 1)),
      };
    });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function loadImageMetadata(src: string): Promise<{ width: number; height: number; image: HTMLImageElement }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve({
      width: image.naturalWidth || image.width || 1,
      height: image.naturalHeight || image.height || 1,
      image,
    });
    image.onerror = reject;
    image.src = src;
  });
}

function createFallbackImagePlaceholder(text: string, width = 800, height = 450): string {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#1c1c1c';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#e4e3e0';
    ctx.font = 'bold 20px serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText((text || 'Chapter Visual').slice(0, 45), width / 2, height / 2);
  }
  return canvas.toDataURL('image/png');
}

async function inlineImageForExport(image: HTMLImageElement): Promise<void> {
  if (!image.src) {
    return;
  }

  let exportSrc = image.src;
  let metadata = {
    width: image.naturalWidth || image.width || 1,
    height: image.naturalHeight || image.height || 1,
  };

  try {
    const loaded = await loadImageMetadata(image.src);
    metadata = { width: loaded.width, height: loaded.height };

    if (!image.src.startsWith('data:image/')) {
      const canvas = document.createElement('canvas');
      canvas.width = loaded.width;
      canvas.height = loaded.height;
      canvas.getContext('2d')?.drawImage(loaded.image, 0, 0);
      exportSrc = canvas.toDataURL('image/png');
    }
  } catch (inlineError) {
    try {
      const response = await fetch(image.src, { mode: 'cors' });
      if (!response.ok) {
        throw inlineError;
      }

      const blob = await response.blob();
      exportSrc = await blobToDataUrl(blob);
      const loaded = await loadImageMetadata(exportSrc);
      metadata = { width: loaded.width, height: loaded.height };
    } catch (fallbackError) {
      console.warn('Failed to inline image for export, using safe placeholder', fallbackError);
      exportSrc = createFallbackImagePlaceholder(image.alt || 'Chapter Visual');
    }
  }

  image.src = exportSrc;
  image.dataset.exportOriginalWidth = String(Math.max(1, Math.round(metadata.width)));
  image.dataset.exportOriginalHeight = String(Math.max(1, Math.round(metadata.height)));
  image.dataset.exportWidth = String(Math.max(1, Math.round(metadata.width)));
  image.dataset.exportHeight = String(Math.max(1, Math.round(metadata.height)));
  image.style.maxWidth = '100%';
  image.style.height = 'auto';
  image.style.display = 'block';
  image.style.margin = '20px auto';
  image.style.filter = 'none';
  image.className = image.className.replace(/grayscale|hover:grayscale-0/g, '').trim();
}

export async function prepareExportContent(
  root: HTMLElement,
  options: PrepareExportContentOptions = {}
): Promise<PreparedExportContent> {
  const { inlineImages = true } = options;
  const clone = root.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(EXPORT_CLEANUP_SELECTOR).forEach((node) => node.remove());

  // Ensure all external hyperlinks open in a new tab page, while internal links remain in the same document
  clone.querySelectorAll('a[href]').forEach((anchor) => {
    const href = anchor.getAttribute('href');
    if (href && (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('//'))) {
      anchor.setAttribute('target', '_blank');
      anchor.setAttribute('rel', 'noopener noreferrer');
    } else if (href && href.startsWith('#')) {
      anchor.setAttribute('target', '_self');
    }
  });

  const images = Array.from(clone.querySelectorAll('img'));

  if (inlineImages) {
    await Promise.all(images.map((image) => inlineImageForExport(image as HTMLImageElement)));
  }

  return {
    clone,
    chapterImages: collectWordChapterImages(clone),
  };
}

// Compact inline Tailwind utility CSS used by the PDF shell.
// This replaces the cdn.tailwindcss.com Play CDN which crashes Puppeteer
// ("Target closed") because it runs DOM-scanning JS in headless Chrome.
const PDF_TAILWIND_INLINE_CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  .font-serif { font-family: 'Playfair Display', ui-serif, Georgia, serif; }
  .font-mono { font-family: 'JetBrains Mono', ui-monospace, monospace; }
  .font-sans { font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; }
  .font-bold { font-weight: 700; } .font-medium { font-weight: 500; } .font-black { font-weight: 900; }
  .italic { font-style: italic; } .uppercase { text-transform: uppercase; } .capitalize { text-transform: capitalize; }
  .text-\\[9px\\] { font-size: 9px; } .text-\\[10px\\] { font-size: 10px; } .text-\\[11px\\] { font-size: 11px; }
  .text-xs  { font-size: .75rem;  line-height: 1rem;    }
  .text-sm  { font-size: .875rem; line-height: 1.25rem; }
  .text-base{ font-size: 1rem;    line-height: 1.5rem;  }
  .text-lg  { font-size: 1.125rem;line-height: 1.75rem; }
  .text-xl  { font-size: 1.25rem; line-height: 1.75rem; }
  .text-2xl { font-size: 1.5rem;  line-height: 2rem;    }
  .text-3xl { font-size: 1.875rem;line-height: 2.25rem; }
  .text-4xl { font-size: 2.25rem; line-height: 2.5rem;  }
  .text-5xl { font-size: 3rem;    line-height: 1;       }
  .text-6xl { font-size: 3.75rem; line-height: 1;       }
  .leading-none { line-height: 1; } .leading-tight { line-height: 1.25; } .leading-snug { line-height: 1.375; }
  .leading-normal { line-height: 1.5; } .leading-relaxed { line-height: 1.625; } .leading-loose { line-height: 2; }
  .tracking-tighter { letter-spacing: -0.05em; } .tracking-tight { letter-spacing: -0.025em; }
  .tracking-wide { letter-spacing: 0.025em; } .tracking-wider { letter-spacing: 0.05em; } .tracking-widest { letter-spacing: 0.1em; }
  .text-white { color: #fff; } .text-black { color: #000; }
  .text-gray-400 { color: #9ca3af; } .text-gray-500 { color: #6b7280; } .text-gray-600 { color: #4b5563; }
  .text-gray-700 { color: #374151; } .text-gray-800 { color: #1f2937; } .text-gray-900 { color: #111827; }
  .text-red-600 { color: #dc2626; } .text-red-700 { color: #b91c1c; } .text-red-800 { color: #991b1b; }
  .text-green-600 { color: #16a34a; } .text-green-700 { color: #15803d; } .text-green-800 { color: #166534; }
  .text-blue-600 { color: #2563eb; } .text-amber-700 { color: #b45309; } .text-amber-900 { color: #78350f; }
  .bg-white { background-color: #fff; } .bg-black { background-color: #000; }
  .bg-gray-50 { background-color: #f9fafb; } .bg-gray-100 { background-color: #f3f4f6; } .bg-gray-200 { background-color: #e5e7eb; }
  .bg-green-100 { background-color: #dcfce7; } .bg-blue-100 { background-color: #dbeafe; }
  .bg-red-50 { background-color: #fef2f2; } .bg-amber-50 { background-color: #fffbeb; }
  .border   { border-width: 1px;  border-style: solid; }
  .border-0 { border-width: 0; }
  .border-2 { border-width: 2px; border-style: solid; }
  .border-t { border-top-width:    1px; border-top-style:    solid; }
  .border-b { border-bottom-width: 1px; border-bottom-style: solid; }
  .border-l { border-left-width:   1px; border-left-style:   solid; }
  .border-r { border-right-width:  1px; border-right-style:  solid; }
  .border-l-2 { border-left-width: 2px; border-left-style: solid; }
  .border-black { border-color: #000; } .border-white { border-color: #fff; }
  .border-gray-200 { border-color: #e5e7eb; } .border-gray-300 { border-color: #d1d5db; }
  .border-gray-800 { border-color: #1f2937; } .border-amber-200 { border-color: #fde68a; }
  .border-red-200   { border-color: #fecaca; } .border-red-400 { border-color: #f87171; }
  .border-amber-300 { border-color: #fcd34d; }
  .rounded    { border-radius: .25rem; } .rounded-sm { border-radius: .125rem; }
  .rounded-lg { border-radius: .5rem;  } .rounded-full { border-radius: 9999px; }
  .flex { display: flex; } .inline-flex { display: inline-flex; } .grid { display: grid; }
  .block { display: block; } .inline { display: inline; } .inline-block { display: inline-block; } .hidden { display: none; }
  .flex-col { flex-direction: column; } .flex-row { flex-direction: row; } .flex-wrap { flex-wrap: wrap; }
  .flex-1 { flex: 1 1 0%; } .shrink-0 { flex-shrink: 0; } .grow { flex-grow: 1; }
  .items-start { align-items: flex-start; } .items-center { align-items: center; } .items-end { align-items: flex-end; }
  .justify-start { justify-content: flex-start; } .justify-center { justify-content: center; }
  .justify-end { justify-content: flex-end; } .justify-between { justify-content: space-between; }
  .gap-1 { gap: .25rem; } .gap-2 { gap: .5rem; } .gap-3 { gap: .75rem; } .gap-4 { gap: 1rem; }
  .gap-6 { gap: 1.5rem; } .gap-8 { gap: 2rem; } .gap-12 { gap: 3rem; }
  .w-full { width: 100%; } .w-1\/2 { width: 50%; } .h-full { height: 100%; }
  .max-w-none { max-width: none; } .max-w-sm { max-width: 24rem; } .max-w-md { max-width: 28rem; }
  .max-w-lg { max-width: 32rem; } .max-w-xl { max-width: 36rem; } .max-w-2xl { max-width: 42rem; }
  .max-w-3xl { max-width: 48rem; } .max-w-4xl { max-width: 56rem; } .max-w-5xl { max-width: 64rem; }
  .max-w-6xl { max-width: 72rem; } .max-w-7xl { max-width: 80rem; }
  .mx-auto { margin-left: auto; margin-right: auto; } .my-auto { margin-top: auto; margin-bottom: auto; }
  .m-0{margin:0} .mt-0{margin-top:0} .mt-1{margin-top:.25rem} .mt-2{margin-top:.5rem} .mt-3{margin-top:.75rem}
  .mt-4{margin-top:1rem} .mt-6{margin-top:1.5rem} .mt-8{margin-top:2rem} .mt-10{margin-top:2.5rem}
  .mb-0{margin-bottom:0} .mb-1{margin-bottom:.25rem} .mb-2{margin-bottom:.5rem} .mb-3{margin-bottom:.75rem}
  .mb-4{margin-bottom:1rem} .mb-6{margin-bottom:1.5rem} .mb-8{margin-bottom:2rem} .mb-10{margin-bottom:2.5rem}
  .ml-auto{margin-left:auto} .mr-auto{margin-right:auto} .mr-4{margin-right:1rem}
  .p-0{padding:0} .p-1{padding:.25rem} .p-2{padding:.5rem} .p-3{padding:.75rem} .p-4{padding:1rem}
  .p-6{padding:1.5rem} .p-8{padding:2rem} .p-10{padding:2.5rem} .p-12{padding:3rem} .p-16{padding:4rem} .p-20{padding:5rem}
  .px-1{padding-left:.25rem;padding-right:.25rem} .px-2{padding-left:.5rem;padding-right:.5rem}
  .px-3{padding-left:.75rem;padding-right:.75rem} .px-4{padding-left:1rem;padding-right:1rem}
  .px-6{padding-left:1.5rem;padding-right:1.5rem} .px-8{padding-left:2rem;padding-right:2rem}
  .py-0\.5{padding-top:.125rem;padding-bottom:.125rem} .py-1{padding-top:.25rem;padding-bottom:.25rem}
  .py-2{padding-top:.5rem;padding-bottom:.5rem} .py-3{padding-top:.75rem;padding-bottom:.75rem}
  .py-4{padding-top:1rem;padding-bottom:1rem}
  .pt-2{padding-top:.5rem} .pt-4{padding-top:1rem} .pt-6{padding-top:1.5rem} .pt-8{padding-top:2rem}
  .pb-1{padding-bottom:.25rem} .pb-2{padding-bottom:.5rem} .pb-4{padding-bottom:1rem} .pb-20{padding-bottom:5rem}
  .pl-2{padding-left:.5rem} .pl-4{padding-left:1rem} .pr-4{padding-right:1rem}
  .overflow-hidden{overflow:hidden} .overflow-auto{overflow:auto} .overflow-x-hidden{overflow-x:hidden}
  .truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .break-words{word-break:break-word;overflow-wrap:break-word} .whitespace-pre-wrap{white-space:pre-wrap}
  .relative{position:relative} .absolute{position:absolute} .top-0{top:0} .right-0{right:0}
  .opacity-30{opacity:.3} .opacity-40{opacity:.4} .opacity-50{opacity:.5} .opacity-60{opacity:.6} .opacity-100{opacity:1}
  .space-y-2>*+*{margin-top:.5rem} .space-y-4>*+*{margin-top:1rem}
  .space-y-6>*+*{margin-top:1.5rem} .space-y-8>*+*{margin-top:2rem}
  .list-disc{list-style-type:disc} .list-inside{list-style-position:inside}
  .min-w-0{min-width:0} .grid-cols-2{grid-template-columns:repeat(2,minmax(0,1fr))}
  .grid-cols-3{grid-template-columns:repeat(3,minmax(0,1fr))}
  .shadow{box-shadow:0 1px 3px 0 rgba(0,0,0,.1)}
  a { color: inherit; text-decoration: underline; }
`;

// Legacy PDF-specific HTML shell retained as a fallback option.
// The active high-res PDF path now reuses the print HTML shell so it can match
// the browser's print/save-as-PDF styling more closely.
function buildPdfHtmlShell(title: string, htmlContent: string, extraCss: string): string {
  return `<!DOCTYPE html>
<html data-render-ready="true">
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  ${EXPORT_FONT_LINKS}
  <style>${PDF_TAILWIND_INLINE_CSS}</style>
  <style>${extraCss}</style>
</head>
<body>
  ${htmlContent}
</body>
</html>`;
}


// buildHtmlShell is used by standalone HTML export, the print/save path, and
// the high-res PDF path. The inline readiness script gives Puppeteer a stable
// signal once external styles and fonts have finished loading.
function buildHtmlShell(title: string, htmlContent: string, headContent: string, bodyAttributes = '', lang = 'en'): string {
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <script src="https://cdn.tailwindcss.com"></script>
  ${EXPORT_FONT_LINKS}
  ${headContent}
</head>
<body${bodyAttributes}>
  ${htmlContent}
  <script>${EXPORT_RENDER_READY_SCRIPT}</script>
</body>
</html>`;
}

export function buildStandaloneHtmlDocument(webBook: WebBook, htmlContent: string): string {
  return buildHtmlShell(
    getWebBookDocumentTitle(webBook.topic),
    htmlContent,
    `
      <style>
        html { scroll-behavior: smooth; }
        body { font-family: 'Inter', sans-serif; background: #E4E3E0; padding: 40px 16px; margin: 0; overflow-x: hidden; }
        .font-serif { font-family: 'Playfair Display', serif; }
        .font-mono { font-family: 'JetBrains Mono', monospace; }
        * { word-break: break-word; overflow-wrap: break-word; box-sizing: border-box; }
        a { color: inherit; }
        .web-book-container { width: 100%; max-width: 900px; margin: 0 auto; display: flex; flex-direction: column; gap: 32px; }
        .web-book-page { background: white; border: 1px solid #141414; box-shadow: 12px 12px 0 rgba(20, 20, 20, 0.12); overflow: hidden; }
        @media print {
          body { background: white; padding: 0; overflow: visible !important; }
          .web-book-container { max-width: none; gap: 0; overflow: visible !important; }
          .web-book-page { box-shadow: none; break-after: page; page-break-after: always; overflow: visible !important; }
          .web-book-page:last-child { break-after: auto; page-break-after: auto; }
        }
      </style>
    `,
    '',
    getExportLabels(webBook).locale
  );
}

export function buildPdfHtmlDocument(webBook: WebBook, htmlContent: string): string {
  return buildPrintHtmlDocument(webBook, htmlContent);
}

export function buildPrintHtmlDocument(webBook: WebBook, htmlContent: string): string {
  return buildHtmlShell(
    getWebBookDocumentTitle(webBook.topic),
    htmlContent,
    `
      <style>${PDF_TAILWIND_INLINE_CSS}</style>
      <style>
        html { scroll-behavior: smooth; }
        body { font-family: 'Inter', sans-serif; background: white; padding: 24px 0; margin: 0; }
        .font-serif { font-family: 'Playfair Display', serif; }
        .font-mono { font-family: 'JetBrains Mono', monospace; }
        .print\\:hidden { display: none !important; }
        .web-book-container { width: 100%; max-width: 800px; margin: 0 auto; display: flex; flex-direction: column; gap: 0; }
        .web-book-page { background: white; width: 100%; min-height: 100vh; display: flex; flex-direction: column; position: relative; box-sizing: border-box; }
        @media print {
          body { padding: 0; margin: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; overflow: visible !important; }
          .no-print { display: none; }
          .web-book-page {
            break-after: page;
            page-break-after: always;
            border: none !important;
            box-shadow: none !important;
            margin: 0 !important;
            padding: 1.5cm !important;
            min-height: auto !important;
            height: auto !important;
            box-sizing: border-box !important;
            overflow: visible !important;
          }
          .web-book-page:last-child { break-after: auto; page-break-after: auto; }
          @page { size: A4; margin: 0; }
        }
      </style>
    `,
    '',
    getExportLabels(webBook).locale
  );
}
