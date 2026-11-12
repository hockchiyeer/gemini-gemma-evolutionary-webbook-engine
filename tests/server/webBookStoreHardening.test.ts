import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createWebBookStoreMiddleware, saveWebBookText } from '../../server/webBookStore.ts';

console.error = () => {};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webbook-hardening-'));
const middleware = createWebBookStoreMiddleware(dir, { maxBodyBytes: 2048 });
const server = http.createServer((req, res) => middleware(req, res, () => { res.statusCode = 404; res.end('next'); }));
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const post = (body: unknown) => fetch(`${base}/api/webbooks/persist`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

try {
  // --- 1. An oversized body is refused with 413 and nothing is written ---------------------------------------------------------
  {
    const before = fs.readdirSync(dir).length;
    const res = await post({ topic: 'big', text: 'x'.repeat(10_000) });
    assert.equal(res.status, 413);
    assert.equal(fs.readdirSync(dir).length, before, 'nothing written for a refused body');

    // a chunked upload declares no length, so the limit has to hold while the body streams in
    const chunk = new TextEncoder().encode(JSON.stringify({ topic: 'chunked', text: 'x'.repeat(1000) }).slice(0, 900));
    const stream = new ReadableStream({ start(controller) { for (let i = 0; i < 10; i += 1) controller.enqueue(chunk); controller.close(); } });
    const chunked = await fetch(`${base}/api/webbooks/persist`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: stream, duplex: 'half' } as RequestInit);
    assert.equal(chunked.status, 413, 'a chunked body past the limit is refused too');
    assert.equal(fs.readdirSync(dir).length, before);
  }

  // --- 2. A normal book is stored, and only ever as a .txt file whatever name the client asks for -----------------------------
  {
    const ok = await post({ topic: '新加坡歌谣', text: '内容'.repeat(20), timestamp: 1773000000000 });
    assert.equal(ok.status, 200);
    const saved = await ok.json() as { fileName: string };
    assert.ok(saved.fileName.endsWith('.txt'));

    for (const asked of ['evil.js', 'noextension', '..', '.', '', '../../x.sh']) {
      const res = await post({ topic: 'named', text: 'hello', fileName: asked });
      assert.equal(res.status, 200, `name ${JSON.stringify(asked)} is handled`);
      const { fileName, filePath } = await res.json() as { fileName: string; filePath: string };
      assert.ok(/\.txt$/i.test(fileName), `${JSON.stringify(asked)} -> ${fileName} is a .txt file`);
      assert.equal(path.dirname(filePath), dir, 'and stays inside the folder');
    }
    assert.ok(fs.readdirSync(dir).every((f) => /\.txt$/i.test(f)), 'the folder holds only .txt files');
    assert.ok(saveWebBookText({ topic: 't', text: 'x', fileName: '..', dir }).fileName.endsWith('.txt'));
  }

  // --- 3. Only .txt files are served back ---------------------------------------------------------------------------------------
  {
    fs.writeFileSync(path.join(dir, 'secret.json'), '{"k":1}');
    const secret = await fetch(`${base}/api/webbooks/file?name=secret.json`);
    assert.equal(secret.status, 400, 'a non-.txt file in the folder is not readable through the API');

    const listed = await (await fetch(`${base}/api/webbooks/list`)).json() as { files: Array<{ fileName: string }> };
    const name = listed.files[0].fileName;
    const text = await fetch(`${base}/api/webbooks/file?name=${encodeURIComponent(name)}`);
    assert.equal(text.status, 200);
    assert.ok((await text.text()).length > 0);
    assert.equal((await fetch(`${base}/api/webbooks/file?name=${encodeURIComponent('../x.txt')}`)).status, 400);
  }
} finally {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('webBookStoreHardening tests passed');
