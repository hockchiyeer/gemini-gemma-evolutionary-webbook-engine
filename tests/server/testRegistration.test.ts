// Fails when a tests/server/*.test.ts file exists but is not run by `npm run test:server`
// (or the script names a file that no longer exists), so a test can never be dropped silently.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');
const script: string = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts['test:server'];
const registered = script.split('&&').map((part) => part.trim().replace(/^tsx\s+/, '')).filter((part) => part.endsWith('.test.ts'));
const onDisk = fs.readdirSync(path.join(root, 'tests', 'server')).filter((f) => f.endsWith('.test.ts')).map((f) => `tests/server/${f}`);

assert.deepEqual(onDisk.filter((f) => !registered.includes(f)), [], 'test files that test:server never runs');
assert.deepEqual(registered.filter((f) => !onDisk.includes(f)), [], 'test:server runs files that do not exist');
assert.equal(new Set(registered).size, registered.length, 'a test is registered twice');

console.log('testRegistration tests passed');
