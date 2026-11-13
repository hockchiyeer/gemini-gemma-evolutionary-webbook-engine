import assert from 'node:assert/strict';
import { downloadBlob, DOWNLOAD_URL_REVOKE_DELAY_MS } from '../../src/services/exportDocument.ts';
import { exportPrintFriendlyWebBookToImage } from '../../src/services/printFriendlyReportExport.ts';

const globals = globalThis as unknown as Record<string, unknown>;
const events: string[] = [];
const clicks: Array<{ href: string; download: string }> = [];

// A minimal browser: enough document/URL for downloadBlob to run in Node.
globals.document = {
  createElement: () => {
    const anchor = { style: {} as Record<string, string>, href: '', download: '', click() { clicks.push({ href: this.href, download: this.download }); events.push('click'); } };
    return anchor;
  },
  body: { appendChild: () => {}, removeChild: () => {} },
};
URL.createObjectURL = () => 'blob:test-url';
URL.revokeObjectURL = (url: string) => { events.push(`revoke:${url}`); };

assert.equal(DOWNLOAD_URL_REVOKE_DELAY_MS >= 30_000, true, 'the default delay leaves a large download time to start');

// 1. The object URL is still valid right after the click, and is released later.
downloadBlob(new Blob(['x']), 'a.pdf', 40);
assert.deepEqual(events, ['click'], 'no revoke in the same tick as the click');
assert.equal(clicks[0].download, 'a.pdf');
await new Promise((resolve) => setTimeout(resolve, 120));
assert.deepEqual(events, ['click', 'revoke:blob:test-url'], 'revoked after the delay');

// 2. The JPG export (streamed page by page) still saves one file per page.
delete globals.document;
globals.document = undefined;
let saved = 0;
const originalCreate = URL.createObjectURL;
URL.createObjectURL = () => { saved += 1; return 'blob:jpg'; };
globals.document = {
  createElement: () => ({ style: {}, click() {} }),
  body: { appendChild: () => {}, removeChild: () => {} },
};
// window stays undefined, so the renderer takes its Node path and hands over one page.
await exportPrintFriendlyWebBookToImage({
  id: 'b', topic: 'T', timestamp: 1,
  chapters: [{ title: 'C', content: 'text', visualSeed: 'c', definitions: [], subTopics: [], sourceUrls: [] }],
} as never);
assert.equal(saved, 1, 'one JPG saved');
URL.createObjectURL = originalCreate;

console.log('downloadBlob tests passed');
