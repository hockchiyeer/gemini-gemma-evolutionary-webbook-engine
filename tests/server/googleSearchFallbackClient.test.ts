import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchGoogleSearchFallback } from '../../src/services/googleSearchFallbackClient.ts';
import { buildGeminiUserFacingErrorMessage } from '../../src/services/geminiUserFacingErrors.ts';
import { isNonJsonResponseText, toPlainTextPreview, tryParseJson } from '../../src/services/safeResponse.ts';

const globals = globalThis as unknown as Record<string, unknown>;
globals.window = { location: { origin: 'http://localhost:3000', href: 'http://localhost:3000/' } };

// Keep the retry back-off instant so the test stays fast.
const realSetTimeout = globalThis.setTimeout;
globals.setTimeout = ((handler: () => void) => realSetTimeout(handler, 0)) as unknown as typeof setTimeout;

type Step = { status?: number; contentType?: string; body: string };

function stubFetch(steps: Step[]): { calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globals.fetch = async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    return new Response(step.body, {
      status: step.status ?? 200,
      headers: step.contentType ? { 'content-type': step.contentType } : {},
    });
  };
  return { calls };
}

const SPA_HTML = '<!doctype html><html><head><title>Evolutionary Web-Book Engine</title>'
  + '<style>body{color:red}</style><script>window.boot=1</script></head><body><div id="root"></div></body></html>';
const validPayload = JSON.parse(readFileSync('tests/cypress/fixtures/search-fallback-quantum-physics.json', 'utf8'));
const livePayload = JSON.parse(readFileSync('tests/cypress/fixtures/search-fallback-quantum-physics-live-shape.json', 'utf8'));

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  assert.fail('Expected the promise to reject');
}

// 1. Existing contract: well-formed payloads pass through unchanged (both Cypress fixture shapes).
{
  stubFetch([{ contentType: 'application/json', body: JSON.stringify(validPayload) }]);
  assert.deepEqual(await fetchGoogleSearchFallback('Quantum Physics'), validPayload);
  stubFetch([{ contentType: 'application/json', body: JSON.stringify(livePayload) }]);
  assert.deepEqual(await fetchGoogleSearchFallback('Quantum Physics'), livePayload);
}

// 2. The reported failure: HTML (SPA fallback) with 200 on every attempt -> clear, sanitised error after 3 attempts.
{
  const { calls } = stubFetch([{ contentType: 'text/html; charset=utf-8', body: SPA_HTML }]);
  const message = await rejectionMessage(fetchGoogleSearchFallback('Taipei mayor election'));
  assert.equal(calls.length, 3);
  assert.match(message, /expected JSON, got text\/html/);
  assert.match(message, /fallback search/i);
  assert.doesNotMatch(message, /<|window\.boot|color:red/);
}

// 3. HTML on the first attempt (cold start / interstitial) then JSON -> recovers without surfacing an error.
{
  const { calls } = stubFetch([
    { contentType: 'text/html', body: SPA_HTML },
    { contentType: 'application/json', body: JSON.stringify(validPayload) },
  ]);
  assert.deepEqual(await fetchGoogleSearchFallback('Quantum Physics'), validPayload);
  assert.equal(calls.length, 2);
}

// 4. JSON body served with a wrong content-type is accepted instead of rejected.
{
  stubFetch([{ contentType: 'text/html', body: JSON.stringify(validPayload) }]);
  assert.deepEqual(await fetchGoogleSearchFallback('Quantum Physics'), validPayload);
  stubFetch([{ body: `\uFEFF${JSON.stringify(validPayload)}` }]);
  assert.deepEqual(await fetchGoogleSearchFallback('Quantum Physics'), validPayload);
}

// 5. Requests ask for JSON and bypass caches.
{
  const { calls } = stubFetch([{ contentType: 'application/json', body: JSON.stringify(validPayload) }]);
  await fetchGoogleSearchFallback('Quantum Physics', { mode: 'duckduckgo' });
  assert.equal((calls[0].init?.headers as Record<string, string>).Accept, 'application/json');
  assert.equal(calls[0].init?.cache, 'no-store');
  assert.equal(new URL(calls[0].url).searchParams.get('mode'), 'duckduckgo');
}

// 6. Existing contract: 503 JSON error keeps the server-provided message (Cypress "transport failure" scenario).
{
  const { calls } = stubFetch([{
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'Live fallback search is unavailable in this Cypress scenario.' }),
  }]);
  assert.equal(
    await rejectionMessage(fetchGoogleSearchFallback('Quantum Physics')),
    'Live fallback search is unavailable in this Cypress scenario.'
  );
  assert.equal(calls.length, 3);
}

// 7. Gateway HTML error pages (502/504) produce the default message, never raw HTML.
{
  stubFetch([{ status: 504, contentType: 'text/html', body: '<html><body><h1>504 Gateway Time-out</h1></body></html>' }]);
  assert.equal(
    await rejectionMessage(fetchGoogleSearchFallback('Quantum Physics')),
    'Google Search + DuckDuckGo fallback search is currently unavailable.'
  );
}

// 8. Deterministic client errors (400 + JSON message) are not retried; "off" never hits the network.
{
  const { calls } = stubFetch([{ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Query is required' }) }]);
  assert.equal(await rejectionMessage(fetchGoogleSearchFallback('x')), 'Query is required');
  assert.equal(calls.length, 1);
  const offCalls = stubFetch([{ body: '{}' }]).calls;
  assert.equal(await rejectionMessage(fetchGoogleSearchFallback('x', { mode: 'off' })), 'Fallback search is disabled for this request.');
  assert.equal(offCalls.length, 0);
}

// 9. Structurally odd but valid JSON degrades to the existing "no usable evidence" path (empty results), never a TypeError.
{
  stubFetch([{ contentType: 'application/json', body: JSON.stringify({ results: [null, 7, { title: 'No url' }, { title: 'Ok', url: 'https://example.com/a' }] }) }]);
  const payload = await fetchGoogleSearchFallback('Quantum Physics');
  assert.equal(payload.query, 'Quantum Physics');
  assert.equal(payload.provider, 'google');
  assert.deepEqual(payload.results.map((result) => [result.title, result.url, result.snippet]), [['Ok', 'https://example.com/a', '']]);
  assert.deepEqual(payload.aiOverview, []);
  assert.deepEqual(payload.diagnostics, []);

  stubFetch([{ contentType: 'application/json', body: '[]' }]);
  assert.match(await rejectionMessage(fetchGoogleSearchFallback('Quantum Physics')), /invalid response format/);
  stubFetch([{ contentType: 'application/json', body: JSON.stringify({ results: 'nope' }) }]);
  assert.deepEqual((await fetchGoogleSearchFallback('Quantum Physics')).results, []);
}

// 10. Gemini-side error text never echoes raw HTML or the cryptic browser JSON-parse error.
{
  const htmlMessage = buildGeminiUserFacingErrorMessage(new Error(SPA_HTML), 'service_unavailable');
  assert.match(htmlMessage, /^Gemini is temporarily unavailable/);
  assert.doesNotMatch(htmlMessage, /<|window\.boot|color:red/);
  assert.match(htmlMessage, /non-JSON \(HTML\) response/);

  const syntaxMessage = buildGeminiUserFacingErrorMessage(
    new SyntaxError('Unexpected token \'<\', "<!DOCTYPE "... is not valid JSON'),
    'service_unavailable'
  );
  assert.doesNotMatch(syntaxMessage, /Unexpected token/);
  assert.match(syntaxMessage, /non-JSON \(HTML\) response/);

  // Existing behaviour is untouched for ordinary errors.
  assert.equal(buildGeminiUserFacingErrorMessage(new Error('boom'), null), 'boom');
  assert.equal(
    buildGeminiUserFacingErrorMessage({ error: { message: 'API key not valid' } }, 'invalid_api_key'),
    'Gemini API key was rejected by Google. Check GEMINI_API_KEY or VITE_GEMINI_API_KEY and try again.\n\nDetails: API key not valid'
  );
}

// 11. Helper behaviour.
{
  assert.equal(isNonJsonResponseText('Quota exceeded for model'), false);
  assert.equal(isNonJsonResponseText('<!DOCTYPE html><html></html>'), true);
  assert.equal(toPlainTextPreview(SPA_HTML), 'Evolutionary Web-Book Engine');
  assert.deepEqual(tryParseJson('  {"a":1} '), { ok: true, value: { a: 1 } });
  assert.deepEqual(tryParseJson('<html>'), { ok: false });
  assert.deepEqual(tryParseJson(''), { ok: false });
}

console.log('googleSearchFallbackClient resilience tests passed');
