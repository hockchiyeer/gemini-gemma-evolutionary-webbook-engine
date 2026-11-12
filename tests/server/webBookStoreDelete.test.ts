import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createWebBookStoreMiddleware, saveWebBookText } from '../../server/webBookStore.ts';

console.error = () => {};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webbook-delete-'));
const middleware = createWebBookStoreMiddleware(dir);
const server = http.createServer((req, res) => middleware(req, res, () => { res.statusCode = 404; res.end('next'); }));
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const del = (query: string, headers: Record<string, string> = {}) => fetch(`${base}/api/webbooks/file?${query}`, { method: 'DELETE', headers });
const seed = () => {
  fs.readdirSync(dir).forEach((f) => fs.unlinkSync(path.join(dir, f)));
  saveWebBookText({ topic: 'Quantum', text: 'QUANTUM\nbody', timestamp: 1000, dir });
  saveWebBookText({ topic: 'Quantum Computing', text: 'QUANTUM COMPUTING\nbody', timestamp: 2000, dir });
  saveWebBookText({ topic: '马来西亚政治格局', text: '马来西亚政治格局\nbody', timestamp: 3000, dir });
};

try {
  // 1. A topic removes exactly its own file, not files whose name merely contains it.
  seed();
  let res = await del(`topic=${encodeURIComponent('quantum')}`);
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { deletedCount: number }).deletedCount, 1);
  assert.equal(fs.readdirSync(dir).length, 2);
  assert.ok(fs.readdirSync(dir).some((f) => f.includes('Quantum_Computing')), 'the longer topic survives');

  // 2. CJK topics match through the file header.
  res = await del(`topic=${encodeURIComponent('马来西亚政治格局')}`);
  assert.equal(((await res.json()) as { deletedCount: number }).deletedCount, 1);

  // 3. Blank topic or name must never match everything.
  seed();
  assert.equal((await del('topic=%20')).status, 400);
  assert.equal((await del('name=%20')).status, 400);
  assert.equal((await del('topic=')).status, 400);
  assert.equal(fs.readdirSync(dir).length, 3, 'a blank request deletes nothing');

  // 4. File names are still confined to .txt files inside the folder.
  for (const bad of ['../x.txt', 'a/b.txt', 'secret.json']) {
    assert.equal((await del(`name=${encodeURIComponent(bad)}`)).status, 400, bad);
  }

  // 5. A browser request from another site is refused, a same-site one is not.
  assert.equal((await del('topic=Quantum', { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await fetch(`${base}/api/webbooks/all`, { method: 'POST', headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal(fs.readdirSync(dir).length, 3, 'nothing deleted by cross-site requests');
  assert.equal((await del('topic=Quantum', { Origin: base })).status, 200);

  // 6. Clear-all still works for same-origin callers.
  res = await fetch(`${base}/api/webbooks/all`, { method: 'DELETE' });
  assert.equal(((await res.json()) as { deletedCount: number }).deletedCount, 2);
  assert.equal(fs.readdirSync(dir).length, 0);
} finally {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('webBookStoreDelete tests passed');
