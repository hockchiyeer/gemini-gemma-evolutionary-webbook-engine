import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const artifactsDir = path.join(rootDir, 'artifacts');
const archiveName = 'evolutionary-web-book-engine-google-ai-studio-upload.zip';
const archivePath = path.join(artifactsDir, archiveName);

const INCLUDED_PATHS = [
  '.env.example',
  '.gitignore',
  '.npmrc',
  'GOOGLE_AI_STUDIO_UPLOAD.md',
  'LICENSE.txt',
  'README.md',
  'index.html',
  'metadata.json',
  'package-lock.json',
  'package.json',
  'server',
  'src',
  'scripts',
  'tsconfig.json',
  'vite.config.ts',
];

const EXCLUDED_NAMES = new Set([
  '.git',
  'artifacts',
  'coverage',
  'dist',
  'node_modules',
  'test-results',
  'tests',
]);

const EXCLUDED_SUFFIXES = [
  '.log',
];

function toPosixPath(value) {
  return value.split(path.sep).join('/');
}

function shouldExclude(relativePath) {
  const normalized = toPosixPath(relativePath);
  const segments = normalized.split('/').filter(Boolean);

  if (segments.some((segment) => EXCLUDED_NAMES.has(segment))) {
    return true;
  }

  return EXCLUDED_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

async function collectFiles(relativePath, files) {
  if (!relativePath || shouldExclude(relativePath)) {
    return;
  }

  const absolutePath = path.join(rootDir, relativePath);
  let fileStat;
  try {
    fileStat = await stat(absolutePath);
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      return;
    }
    throw err;
  }

  if (fileStat.isDirectory()) {
    const entries = await readdir(absolutePath, { withFileTypes: true });

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      await collectFiles(path.join(relativePath, entry.name), files);
    }

    return;
  }

  files[toPosixPath(relativePath)] = new Uint8Array(await readFile(absolutePath));
}

async function main() {
  const files = {};

  for (const relativePath of INCLUDED_PATHS) {
    await collectFiles(relativePath, files);
  }

  await mkdir(artifactsDir, { recursive: true });
  await rm(archivePath, { force: true });

  const zipBuffer = zipSync(files, {
    level: 9,
  });

  await writeFile(archivePath, Buffer.from(zipBuffer));

  const packagedFiles = Object.keys(files).sort();

  console.log(`Created ${archivePath}`);
  console.log(`Packaged ${packagedFiles.length} files`);
  console.log('Included entries:');

  for (const entry of packagedFiles) {
    console.log(` - ${entry}`);
  }
}

await main();
