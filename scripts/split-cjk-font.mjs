// Splits src/assets/fonts/NotoSansSC-Subset.ttf into ~1 MB pieces plus chunks/manifest.json (sizes and SHA-256).
//
// Why pieces: the hosted AI Studio preview answers one 7 MB download with "429 Too Many Requests". src/services/pdfCjkFont.ts downloads the
// pieces one by one, caches each in the browser and verifies it against this manifest, so a retry only fetches what is still missing.
// Run by make-cjk-font-subset.sh; run it by hand (`node scripts/split-cjk-font.mjs`) after replacing the font. No constants in the code
// need to be edited: the loader reads the sizes from the manifest.
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fontPath = path.join(rootDir, 'src/assets/fonts/NotoSansSC-Subset.ttf');
const chunksDir = path.join(rootDir, 'src/assets/fonts/chunks');
const CHUNK_SIZE = 1024 * 1024;

const font = await readFile(fontPath);
if (font.length < 1024 || !(font[0] === 0 && font[1] === 1 && font[2] === 0 && font[3] === 0)) {
  throw new Error(`${fontPath} is not a TrueType (glyf) font.`);
}

await mkdir(chunksDir, { recursive: true });
for (const name of await readdir(chunksDir)) {
  if (/^part-\d+\.bin$/.test(name) || name === 'manifest.json') await rm(path.join(chunksDir, name));
}

const chunks = [];
for (let offset = 0, index = 0; offset < font.length; offset += CHUNK_SIZE, index += 1) {
  const piece = font.subarray(offset, offset + CHUNK_SIZE);
  const name = `part-${String(index).padStart(2, '0')}.bin`;
  await writeFile(path.join(chunksDir, name), piece);
  chunks.push({ name, size: piece.length, sha256: createHash('sha256').update(piece).digest('hex') });
}

const manifest = {
  file: 'NotoSansSC-Subset.ttf',
  totalSize: font.length,
  sha256: createHash('sha256').update(font).digest('hex'),
  chunks,
};
await writeFile(path.join(chunksDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${chunks.length} pieces (${font.length} bytes) and manifest.json to ${path.relative(rootDir, chunksDir)}`);
