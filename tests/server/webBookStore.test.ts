import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  sanitizeFileName,
  saveWebBookText,
  listPersistedWebBooks,
} from "../../server/webBookStore.ts";

// 1. sanitizeFileName cleans forbidden Windows and Unix characters
{
  const unsafeTopic = 'What is "Quantum" Computing? / A Guide: Part 1 <Basics> | 2026*';
  const timestamp = 1773000000000;
  const fileName = sanitizeFileName(unsafeTopic, timestamp);

  assert.ok(fileName.endsWith(".txt"), "must end with .txt");
  assert.ok(!fileName.includes('"'), 'must not contain "');
  assert.ok(!fileName.includes("?"), "must not contain ?");
  assert.ok(!fileName.includes("/"), "must not contain /");
  assert.ok(!fileName.includes(":"), "must not contain :");
  assert.ok(!fileName.includes("<"), "must not contain <");
  assert.ok(!fileName.includes(">"), "must not contain >");
  assert.ok(!fileName.includes("|"), "must not contain |");
  assert.ok(!fileName.includes("*"), "must not contain *");
  assert.ok(!fileName.includes(" "), "spaces must be replaced by underscores");

  const fallback = sanitizeFileName("");
  assert.ok(fallback.endsWith("webbook.txt"), "empty topic defaults to webbook.txt");
}

// 2. saveWebBookText writes file and prevents path traversal
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "webbook-store-test-"));
try {
  const sampleText = "==================================================\nSAMPLE WEBBOOK\n==================================================";
  const result = saveWebBookText({
    topic: "Test Persistence",
    text: sampleText,
    timestamp: 1773000000000,
    dir: tempDir,
  });

  assert.ok(fs.existsSync(result.filePath), "persisted text file must exist on disk");
  assert.equal(fs.readFileSync(result.filePath, "utf8"), sampleText);
  assert.equal(result.bytesWritten, Buffer.byteLength(sampleText, "utf8"));

  // Path traversal attempt via custom fileName should be sanitized by path.basename
  const traversalAttempt = saveWebBookText({
    topic: "Malicious Traversal",
    text: "should not escape",
    fileName: "../../escaped.txt",
    dir: tempDir,
  });
  assert.equal(path.dirname(traversalAttempt.filePath), tempDir, "must stay strictly inside targetDir");
  assert.equal(traversalAttempt.fileName, "escaped.txt");

  // 3. listPersistedWebBooks returns saved files sorted by mtime descending
  const files = listPersistedWebBooks(tempDir);
  assert.ok(files.length >= 2, "must list persisted files");
  assert.ok(files.every((f) => f.fileName.endsWith(".txt")), "all listed entries must be .txt files");
  assert.ok(files[0].modifiedAt >= files[1].modifiedAt, "must sort descending by modifiedAt");
} finally {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
}

console.log("webBookStore tests passed");
