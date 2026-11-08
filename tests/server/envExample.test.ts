import assert from 'node:assert/strict';
import fs from 'node:fs';
import dotenv from 'dotenv';

// .env.example is copied to .env by people (and used to be by a setup script). A live `KEY=` line with no value is not "unset": dotenv
// sets it to the empty string, which the server reads as 0 - turning off Gemini retries and the request timeout. So every tunable must
// stay a comment. And every setting the example documents must be explained in the README, and the other way round.

const example = fs.readFileSync('.env.example', 'utf8');
const readme = fs.readFileSync('README.md', 'utf8');

// 1. Only these keys may be live in the example (they are secrets / identifiers, not tunables)
const ALLOWED_LIVE = new Set([
  'GEMINI_API_KEY', 'PORT',
  'VITE_FIREBASE_API_KEY', 'VITE_FIREBASE_APP_ID', 'VITE_FIREBASE_AUTH_DOMAIN', 'VITE_FIREBASE_MEASUREMENT_ID',
  'VITE_FIREBASE_MESSAGING_SENDER_ID', 'VITE_FIREBASE_PROJECT_ID', 'VITE_FIREBASE_STORAGE_BUCKET',
]);
const live = Object.keys(dotenv.parse(example));
assert.deepEqual(live.filter((key) => !ALLOWED_LIVE.has(key)), [], 'tunables in .env.example must be commented out');

// 2. Simulate copying it to .env: the effective settings must equal the documented defaults
{
  const saved = { ...process.env };
  for (const [key, value] of Object.entries(dotenv.parse(example))) if (key.startsWith('GEMINI_') || key.startsWith('LOCAL_LLM_') || key === 'LLM_PROVIDER') process.env[key] = value;
  const asNumber = (name: string, fallback: number) => { const n = Number(process.env[name]); return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback; };
  assert.equal(asNumber('GEMINI_MAX_ATTEMPTS', 4), 4);
  assert.equal(asNumber('GEMINI_REQUEST_TIMEOUT_MS', 50000), 50000);
  assert.equal(asNumber('GEMINI_MAX_CONCURRENCY', 3), 3);
  assert.equal(process.env.GEMINI_API_KEY, '', 'the key itself is the one live empty value, and an empty key is "no key"');
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
}

// 3. Every setting documented as a comment in the example appears in the README, and every LOCAL_LLM_* / LLM_PROVIDER in the README is in the example
const documented = new Set([...example.matchAll(/^#\s*([A-Z][A-Z0-9_]{3,})=/gm)].map((m) => m[1]));
for (const key of documented) assert.ok(readme.includes(key), `${key} is in .env.example but not explained in README.md`);
const inReadme = new Set([...readme.matchAll(/`((?:LOCAL_LLM_[A-Z_]+)|LLM_PROVIDER|SKIP_LOCAL_LLM_SETUP)`/g)].map((m) => m[1]));
for (const key of inReadme) assert.ok(documented.has(key) || key === 'LOCAL_LLM_*', `${key} is in README.md but missing from .env.example`);

// 4. The documented defaults match the code
const defaults = await import('../../server/localModelDefaults.mjs');
assert.ok(example.includes(`LOCAL_LLM_MODEL_URI=${defaults.DEFAULT_LOCAL_MODEL_URI}`), 'the example names the default model the code uses');
assert.ok(example.includes(`LOCAL_LLM_CONTEXT_SIZE=${defaults.DEFAULT_LOCAL_CONTEXT_SIZE}`));

console.log('envExample tests passed');
