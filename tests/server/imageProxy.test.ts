import assert from 'node:assert/strict';
import http from 'node:http';
import { createImageProxyMiddleware, isAllowedImageUrl, IMAGE_PROXY_ROUTE } from '../../server/imageProxy.ts';
import { getImageProxyUrl } from '../../src/services/exportDocument.ts';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const PICSUM = 'https://picsum.photos/seed/silicon/1200/800';

// --- 1. Only a picsum picture is ever accepted ---------------------------------------------------
assert.ok(isAllowedImageUrl(PICSUM));
assert.ok(isAllowedImageUrl('https://picsum.photos/id/237/200/300.jpg'));
assert.ok(isAllowedImageUrl(`https://picsum.photos/seed/${encodeURIComponent('马来西亚 politics')}/1200/800`));
for (const bad of [
  '',
  'not a url',
  'http://picsum.photos/seed/a/1200/800', // not https
  'https://evil.example/seed/a/1200/800',
  'https://picsum.photos.evil.example/seed/a/1200/800',
  'https://picsum.photos@evil.example/seed/a/1200/800', // user-info trick
  'https://user:pw@picsum.photos/seed/a/1200/800',
  'https://picsum.photos:8443/seed/a/1200/800',
  'https://fastly.picsum.photos/seed/a/1200/800', // only the entry host may be asked for directly
  'https://picsum.photos/seed/a/1200/800?x=1',
  'https://picsum.photos/',
  'https://picsum.photos/seed/a/b/1200/800', // extra path segment
  'https://picsum.photos/../etc/passwd',
  'https://picsum.photos/seed/a/99999/800',
  'file:///etc/passwd',
  'http://127.0.0.1:3000/api/webbooks/all',
  'http://169.254.169.254/latest/meta-data/',
]) {
  assert.equal(isAllowedImageUrl(bad), null, `refused: ${bad}`);
}

// --- 2. The client sends picsum pictures through the proxy and leaves everything else alone ----
assert.equal(getImageProxyUrl(PICSUM), `${IMAGE_PROXY_ROUTE}?u=${encodeURIComponent(PICSUM)}`);
assert.equal(getImageProxyUrl('https://example.com/a.png'), null);
assert.equal(getImageProxyUrl('data:image/png;base64,AAAA'), null);
assert.equal(getImageProxyUrl('/relative.png'), null);
assert.equal(getImageProxyUrl('http://picsum.photos/seed/a/1/1'), null);

// --- 3. The middleware, against a fake upstream ---------------------------------------------------
const calls: Array<{ url: string; redirect?: string }> = [];
let behaviour: (url: string) => Response | Promise<Response> = () => new Response(JPEG, { status: 200, headers: { 'content-type': 'image/jpeg' } });
const fakeFetch = async (input: string, init?: RequestInit) => {
  calls.push({ url: input, redirect: init?.redirect as string });
  return behaviour(input);
};

const middleware = createImageProxyMiddleware({ fetchImpl: fakeFetch, maxBytes: 64, timeoutMs: 300 });
const server = http.createServer((req, res) => middleware(req, res, () => { res.statusCode = 404; res.end('next'); }));
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const get = (u: string | null, init?: RequestInit) =>
  fetch(`${base}${IMAGE_PROXY_ROUTE}${u === null ? '' : `?u=${encodeURIComponent(u)}`}`, init);

try {
  // a. Happy path: bytes, type and caching headers, redirects handled by the proxy and never followed blindly
  behaviour = (url) =>
    url === PICSUM
      ? new Response(null, { status: 302, headers: { location: 'https://fastly.picsum.photos/id/1/1200/800.jpg' } })
      : new Response(JPEG, { status: 200, headers: { 'content-type': 'image/jpeg; charset=binary' } });
  let res = await get(PICSUM);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.match(res.headers.get('cache-control') || '', /max-age/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), JPEG);
  assert.deepEqual(calls.map((c) => c.url), [PICSUM, 'https://fastly.picsum.photos/id/1/1200/800.jpg']);
  assert.ok(calls.every((c) => c.redirect === 'manual'), 'redirects are followed by hand so each hop can be checked');

  // b. A second request for the same picture is served from memory
  const before = calls.length;
  res = await get(PICSUM);
  assert.equal(res.status, 200);
  await res.arrayBuffer();
  assert.equal(calls.length, before, 'cache hit makes no upstream call');

  // c. Bad input never reaches the upstream
  const callsBefore = calls.length;
  assert.equal((await get(null)).status, 400);
  assert.equal((await get('https://evil.example/seed/a/1200/800')).status, 400);
  assert.equal((await get('http://169.254.169.254/latest/meta-data/')).status, 400);
  assert.equal(calls.length, callsBefore, 'nothing fetched for refused input');

  // d. Only GET/HEAD; other paths fall through to the app
  assert.equal((await get(PICSUM, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${base}/somewhere-else`)).status, 404);

  // e. A redirect off picsum is refused
  behaviour = () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:3000/api/webbooks/all' } });
  assert.equal((await get('https://picsum.photos/seed/redir/1200/800')).status, 502);
  behaviour = () => new Response(null, { status: 302, headers: { location: 'https://picsum.photos.evil.example/x.jpg' } });
  assert.equal((await get('https://picsum.photos/seed/redir2/1200/800')).status, 502);

  // f. Redirect loops stop
  behaviour = () => new Response(null, { status: 302, headers: { location: 'https://fastly.picsum.photos/loop.jpg' } });
  assert.equal((await get('https://picsum.photos/seed/loop/1200/800')).status, 502);

  // g. Only real images, and only up to the size limit
  behaviour = () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
  assert.equal((await get('https://picsum.photos/seed/html/1200/800')).status, 502);
  behaviour = () => new Response('<svg onload="alert(1)"/>', { status: 200, headers: { 'content-type': 'image/svg+xml' } });
  assert.equal((await get('https://picsum.photos/seed/svg/1200/800')).status, 502);
  behaviour = () => new Response(Buffer.alloc(200), { status: 200, headers: { 'content-type': 'image/jpeg' } });
  assert.equal((await get('https://picsum.photos/seed/big/1200/800')).status, 502);
  behaviour = () => new Response(Buffer.alloc(0), { status: 200, headers: { 'content-type': 'image/jpeg' } });
  assert.equal((await get('https://picsum.photos/seed/empty/1200/800')).status, 502);

  // h. Upstream errors and a slow upstream give a clean error, not a hang
  behaviour = () => new Response('nope', { status: 503 });
  assert.equal((await get('https://picsum.photos/seed/down/1200/800')).status, 502);
  behaviour = () => { throw new Error('connect ECONNREFUSED'); };
  assert.equal((await get('https://picsum.photos/seed/refused/1200/800')).status, 502);
  const slow = createImageProxyMiddleware({
    timeoutMs: 80,
    fetchImpl: (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }),
  });
  const slowServer = http.createServer((req, res) => slow(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise<void>((resolve) => slowServer.listen(0, '127.0.0.1', resolve));
  const slowBase = `http://127.0.0.1:${(slowServer.address() as { port: number }).port}`;
  const timedOut = await fetch(`${slowBase}${IMAGE_PROXY_ROUTE}?u=${encodeURIComponent('https://picsum.photos/seed/slow/1200/800')}`);
  assert.equal(timedOut.status, 504);
  slowServer.close();
} finally {
  server.close();
}

console.log('imageProxy tests passed');
