import assert from 'node:assert/strict';
import { CjkFontUnavailableError, loadCjkFontBase64 } from '../../src/services/pdfCjkFont.ts';

// A hosted preview answers the 17 MB font download with 429 while it is busy: the export must retry, not fail.
const ttf = new Uint8Array(4096);
ttf.set([0, 1, 0, 0]);
const realFetch = globalThis.fetch;
const calls: string[] = [];

// 404 is not retried, and the failure is the typed error that tells the user why (runs first: a success would be cached by the module)
{
  globalThis.fetch = (async (input: unknown) => {
    calls.push(String(input));
    return new Response('missing', { status: 404 });
  }) as typeof fetch;
  await assert.rejects(() => loadCjkFontBase64(['https://example.test/missing.ttf']), (err: unknown) => {
    assert.ok(err instanceof CjkFontUnavailableError);
    assert.ok(err.attempts[0].includes('404'));
    return true;
  });
  assert.equal(calls.length, 1, '404 is not retried');
}

{
  calls.length = 0;
  let busy = 2;
  globalThis.fetch = (async (input: unknown) => {
    calls.push(String(input));
    if (busy > 0) {
      busy -= 1;
      return new Response('slow down', { status: 429, headers: { 'retry-after': '0.01' } });
    }
    return new Response(ttf, { status: 200 });
  }) as typeof fetch;
  const base64 = await loadCjkFontBase64(['https://example.test/font.ttf', 'https://example.test/font.ttf']);
  assert.ok(base64.length > 1000, 'font loaded after two 429 answers');
  assert.equal(calls.length, 3, 'two retries, then success; the duplicate URL was not requested again');
}

globalThis.fetch = realFetch;
console.log('pdfCjkFont retry tests passed');
