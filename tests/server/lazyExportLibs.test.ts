import assert from 'node:assert/strict';
import { ExportLibraryLoadError, loadExportLibrary } from '../../src/services/lazyExportLibs.ts';

// A lazy import that fails once (busy preview server) succeeds on the retry.
let calls = 0;
const value = await loadExportLibrary('jspdf', async () => {
  calls += 1;
  if (calls < 2) throw new TypeError('Failed to fetch dynamically imported module');
  return 42;
}, 2, 5);
assert.equal(value, 42);
assert.equal(calls, 2);

// A permanently stale module URL ends in a clear "reload the page" message instead of the raw browser error.
await assert.rejects(
  () => loadExportLibrary('html2canvas', async () => { throw new TypeError('Failed to fetch dynamically imported module: x.js?v=old'); }, 1, 5),
  (err: unknown) => err instanceof ExportLibraryLoadError && /reload the page/.test(err.message) && /html2canvas/.test(err.message)
);
console.log('lazyExportLibs tests passed');
