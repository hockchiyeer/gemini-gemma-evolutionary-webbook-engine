import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { MAX_BODY_BYTES, createWebBookStoreMiddleware } from '../../server/webBookStore.ts';

console.error = () => {};

assert.equal(MAX_BODY_BYTES, 25 * 1024 * 1024);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webbook-limits-'));
const middleware = createWebBookStoreMiddleware(dir, { maxBodyBytes: 2048 });
const server = http.createServer((req, res) => middleware(req, res, () => { res.statusCode = 404; res.end('next'); }));
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const persist = (body: BodyInit, extra: Record<string, unknown> = {}) =>
  fetch(`${base}/api/webbooks/persist`, { method: 'POST', headers: { 'content-type': 'application/json' }, body, ...extra } as RequestInit);

try {
  // --- 1. Over the limit: 413 whether or not the upload declares its length (a normal fetch does; a stream does not) ----------
  {
    const before = fs.readdirSync(dir).length;
    const declared = await persist(JSON.stringify({ topic: 'big', text: 'x'.repeat(10_000) }));
    assert.equal(declared.status, 413, 'a body that declares its size is refused with 413, not 500');

    const bytes = new TextEncoder().encode(JSON.stringify({ topic: 'chunked', text: 'x'.repeat(10_000) }));
    const stream = new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 1000) c.enqueue(bytes.slice(i, i + 1000)); c.close(); } });
    const chunked = await persist(stream as unknown as BodyInit, { duplex: 'half' });
    assert.equal(chunked.status, 413, 'a streamed body past the limit is refused with 413');
    assert.equal(fs.readdirSync(dir).length, before, 'nothing is written for a refused body');
  }

  // --- 2. Under the limit: stored, and only ever as a .txt file whatever name the client asks for -------------------------------
  {
    for (const asked of [undefined, 'evil.js', 'noextension', '..', '.', '../../x.sh', 'UPPER.TXT']) {
      const res = await persist(JSON.stringify({ topic: 'named', text: 'hello', fileName: asked }));
      assert.equal(res.status, 200, `name ${JSON.stringify(asked)} is accepted`);
      const { fileName, filePath } = await res.json() as { fileName: string; filePath: string };
      assert.ok(/\.txt$/i.test(fileName), `${JSON.stringify(asked)} -> ${fileName} is a .txt file`);
      assert.equal(path.dirname(filePath), dir, 'and stays inside the folder');
    }
    assert.ok(fs.readdirSync(dir).every((f) => /\.txt$/i.test(f)), 'the folder holds only .txt files');
  }

  // --- 3. Only .txt files are served back ---------------------------------------------------------------------------------------
  {
    fs.writeFileSync(path.join(dir, 'secret.json'), '{"k":1}');
    assert.equal((await fetch(`${base}/api/webbooks/file?name=secret.json`)).status, 400);
    assert.equal((await fetch(`${base}/api/webbooks/file?name=${encodeURIComponent('../x.txt')}`)).status, 400);
    const saved = await (await persist(JSON.stringify({ topic: '新加坡歌谣', text: '内容'.repeat(10), timestamp: 1773000000000 }))).json() as { fileName: string };
    const ok = await fetch(`${base}/api/webbooks/file?name=${encodeURIComponent(saved.fileName)}`);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), '内容'.repeat(10));
    const listed = await (await fetch(`${base}/api/webbooks/list`)).json() as { files: Array<{ fileName: string }> };
    assert.ok(listed.files.some((f) => f.fileName === saved.fileName), 'and it is listed');
  }
} finally {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('webBookStoreLimits tests passed');
