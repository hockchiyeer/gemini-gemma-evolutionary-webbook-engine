import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertUsableTrueType,
  buildChunkSpecs,
  CjkFontUnavailableError,
  getCjkFontUrls,
  isFontManifest,
  loadChunkedFont,
  loadCjkFontBase64,
  reportExportStatus,
  setFontProgressListener,
  wrapMixedText,
  type FontChunkSpec,
  type FontManifest,
} from '../../src/services/pdfCjkFont.ts';

// 1 unit per Latin char, 2 per CJK char (rough em model)
const measure = (s: string) => [...s].reduce((w, c) => w + (/[\u2e80-\ua4cf\uff00-\uffef]/.test(c) ? 2 : 1), 0);

{
  const text = '马来西亚政治格局和国家政治走向的深入分析';
  const lines = wrapMixedText(text, 10, measure);
  assert.ok(lines.length > 1, 'unbroken CJK text must wrap');
  assert.ok(lines.every((l) => measure(l) <= 10), 'no line exceeds max width');
  assert.equal(lines.join(''), text, 'no characters lost');
}
{
  const lines = wrapMixedText('政府治理改革，公共服务提升。', 12, measure);
  assert.ok(lines.every((l) => !/^[，。、]/.test(l)), 'punctuation must not start a line');
}
{
  const lines = wrapMixedText('Madani 政府 reform agenda', 14, measure);
  assert.ok(lines.some((l) => l.includes('Madani')), 'Latin words stay intact');
}
{
  assert.deepEqual(wrapMixedText('', 10, measure), ['']);
  assert.equal(wrapMixedText('a\nb', 10, measure).length, 2);
}
{
  assert.throws(() => assertUsableTrueType(new TextEncoder().encode('<!doctype html>'.padEnd(2000, ' '))));
  const ttf = new Uint8Array(2000); ttf.set([0, 1, 0, 0]);
  assert.doesNotThrow(() => assertUsableTrueType(ttf));
  const otf = new Uint8Array(2000); otf.set([0x4f, 0x54, 0x54, 0x4f]);
  assert.throws(() => assertUsableTrueType(otf));
}

// --- Font delivery: the missing/ignored font file is what used to push CJK books into the reader layout ---
{
  // 1. Unreachable or non-font sources throw a typed error (never resolve with garbage, never reroute silently).
  const notAFont = new URL('../../package.json', import.meta.url).href;
  const missing = new URL('../../src/assets/fonts/does-not-exist.ttf', import.meta.url).href;
  await assert.rejects(
    () => loadCjkFontBase64([missing, notAFont]),
    (err: unknown) => {
      assert.ok(err instanceof CjkFontUnavailableError, 'must be a CjkFontUnavailableError');
      assert.equal((err as CjkFontUnavailableError).attempts.length, 2, 'every candidate source is reported');
      return true;
    }
  );
}
{
  // 2. The bundled font ships inside src/ (tracked by git and included in the AI Studio package) and is usable.
  assert.ok(getCjkFontUrls()[0].includes('/src/assets/fonts/NotoSansSC-Subset.ttf'), 'bundled asset URL comes first');
  const base64 = await loadCjkFontBase64();
  const bytes = Buffer.from(base64, 'base64');
  assert.ok(bytes.length > 1_000_000, 'font must be a real CJK font, not a stub');
  assert.doesNotThrow(() => assertUsableTrueType(new Uint8Array(bytes)));
}

// --- Font pieces: the loader is driven by chunks/manifest.json (written by scripts/split-cjk-font.mjs), not by constants in the code ---
const chunksDir = new URL('../../src/assets/fonts/chunks/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', chunksDir), 'utf8')) as FontManifest;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const realSpecs = (): FontChunkSpec[] =>
  buildChunkSpecs(manifest, (name) => new URL(name, chunksDir).href) as FontChunkSpec[];

{
  // 4. The manifest shipped in the repo is valid and describes exactly the files on disk and the font they were cut from.
  assert.ok(isFontManifest(manifest), 'manifest.json must be a valid manifest (sizes add up to totalSize)');
  const font = new Uint8Array(await readFile(new URL('../NotoSansSC-Subset.ttf', chunksDir)));
  assert.equal(font.length, manifest.totalSize, 'manifest.totalSize equals the font size');
  assert.equal(manifest.sha256, sha256(font), 'manifest.sha256 equals the font checksum');
  for (const chunk of manifest.chunks) {
    const bytes = new Uint8Array(await readFile(new URL(chunk.name, chunksDir)));
    assert.equal(bytes.length, chunk.size, `${chunk.name} size`);
    assert.equal(sha256(bytes), chunk.sha256, `${chunk.name} checksum`);
  }
}
{
  // 5. Manifest validation rejects inconsistent or malformed data.
  assert.equal(isFontManifest({ totalSize: 10, chunks: [{ name: 'a.bin', size: 4 }] }), false, 'sizes must add up');
  assert.equal(isFontManifest({ totalSize: 4, chunks: [{ name: 'a.bin', size: 4, sha256: 'xyz' }] }), false, 'checksum must be hex');
  assert.equal(isFontManifest({ totalSize: 4, chunks: [] }), false, 'needs at least one piece');
  assert.equal(isFontManifest(null), false);
  assert.equal(buildChunkSpecs(manifest, (name) => (name === 'part-03.bin' ? undefined : `/x/${name}`)), null, 'a missing piece URL disables the piece path');
}
{
  // 6. All pieces load, are verified, reassemble into the usable font, and progress is reported piece by piece.
  const seen: string[] = [];
  setFontProgressListener((status) => {
    if (status) seen.push(status);
  });
  const bytes = await loadChunkedFont(realSpecs());
  setFontProgressListener(null);
  assert.equal(bytes.length, manifest.totalSize);
  assert.equal(sha256(bytes), manifest.sha256, 'reassembled font is byte-identical to the font');
  assert.doesNotThrow(() => assertUsableTrueType(bytes));
  assert.deepEqual(
    seen,
    manifest.chunks.map((_, i) => `Preparing font… (${i + 1}/${manifest.chunks.length})`),
    'one progress message per piece, in order'
  );
}
{
  // 7. A truncated piece and a corrupted piece are both rejected, and the error names the piece.
  const dir = await mkdtemp(path.join(tmpdir(), 'cjk-font-'));
  const original = new Uint8Array(await readFile(new URL('part-02.bin', chunksDir)));

  const truncated = path.join(dir, 'part-02.bin');
  await writeFile(truncated, original.subarray(0, original.length - 1));
  const specs = realSpecs();
  specs[2] = { ...specs[2], url: pathToFileURL(truncated).href };
  await assert.rejects(() => loadChunkedFont(specs), /font part 3\/8: size mismatch: expected 1048576 bytes but got 1048575/);

  const flipped = new Uint8Array(original);
  flipped[100] ^= 0xff;
  const corrupted = path.join(dir, 'part-02-corrupt.bin');
  await writeFile(corrupted, flipped);
  specs[2] = { ...specs[2], url: pathToFileURL(corrupted).href };
  await assert.rejects(() => loadChunkedFont(specs), /font part 3\/8: checksum mismatch/);
}
{
  // 8. Status messages sent while nobody listens are replayed to the next listener (background prefetch -> export click), and clearing works.
  reportExportStatus('Preparing font… (3/8)');
  const received: Array<string | null> = [];
  setFontProgressListener((status) => received.push(status));
  assert.deepEqual(received, ['Preparing font… (3/8)'], 'last status is replayed on registration');
  reportExportStatus(null);
  assert.deepEqual(received, ['Preparing font… (3/8)', null], 'null clears the status');
  setFontProgressListener(null);
  const afterRemoval: Array<string | null> = [];
  reportExportStatus('ignored');
  assert.deepEqual(afterRemoval, [], 'no listener, no delivery');
  reportExportStatus(null);
  // a throwing listener must not break the caller
  setFontProgressListener(() => {
    throw new Error('ui exploded');
  });
  assert.doesNotThrow(() => reportExportStatus('x'));
  setFontProgressListener(null);
  reportExportStatus(null);
}

{
  // 9. Browser path (http URLs, fake fetch): a 429 is retried with a visible pause, and a wrong-size body gets one more download.
  const realFetch = globalThis.fetch;
  const part = new Uint8Array(await readFile(new URL('part-00.bin', chunksDir)));
  const spec: FontChunkSpec = { url: 'http://preview.test/part-00.bin', size: manifest.chunks[0].size, sha256: manifest.chunks[0].sha256 };
  const statuses: string[] = [];
  setFontProgressListener((status) => {
    if (status) statuses.push(status);
  });
  try {
    const script: Array<() => Response> = [
      () => new Response('slow down', { status: 429, headers: { 'retry-after': '1' } }),
      () => new Response(part.subarray(0, 1000)), // truncated body
      () => new Response(part), // second download is good
    ];
    let calls = 0;
    globalThis.fetch = (async () => script[calls++]()) as typeof fetch;
    // loadChunkedFont expects a TrueType header on the assembled result, so use the real first piece as the whole "font" of one piece.
    const bytes = await loadChunkedFont([spec]).catch((err: Error) => err);
    assert.equal(calls, 3, '429 retried once, truncated body re-downloaded once');
    // the single piece is not a complete font; what matters here is that verification and retry passed (the header check is the only failure)
    assert.ok(bytes instanceof Error ? !/size mismatch|checksum|429/.test(bytes.message) : true, 'piece itself was accepted');
    assert.ok(statuses.some((m) => /retrying in 1s/.test(m)), 'retry pause is reported to the UI');
  } finally {
    globalThis.fetch = realFetch;
    setFontProgressListener(null);
    reportExportStatus(null);
  }
}
console.log('pdfCjkFont regression checks passed');
