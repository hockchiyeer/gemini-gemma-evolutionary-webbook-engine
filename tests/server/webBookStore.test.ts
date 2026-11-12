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

  // Custom non-txt extension should be coerced to .txt
  const nonTxtAttempt = saveWebBookText({
    topic: "Malicious Extension",
    text: "should be txt",
    fileName: "malicious.js",
    dir: tempDir,
  });
  assert.ok(nonTxtAttempt.fileName.endsWith(".txt"), "custom fileName must end with .txt");

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

// 4. Test middleware 413 status code for declared Content-Length overflow
{
  const middleware = (await import("../../server/webBookStore.ts")).createWebBookStoreMiddleware();
  let statusCode = 0;
  let responseData = "";
  const req: any = {
    url: "/api/webbooks/persist",
    method: "POST",
    headers: { "content-length": "30000000" }, // 30 MB > 25 MB
  };
  const res: any = {
    setHeader() {},
    end(data: string) {
      responseData = data;
    },
    set statusCode(code: number) {
      statusCode = code;
    },
    get statusCode() {
      return statusCode;
    },
  };

  await middleware(req, res, () => {});
  assert.equal(statusCode, 413, "declared Content-Length > 25MB must return 413 Payload Too Large");
  assert.ok(responseData.includes("exceeds maximum size limit") || responseData.includes("exceeded maximum size limit"), "error payload must explain size limit");
}

// 5. Test DELETE endpoints for deleting individual webbook and clearing all
{
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "webbook-delete-test-"));
  try {
    saveWebBookText({ topic: "Book 1", text: "Book 1\nText 1", fileName: "book1.txt", dir: testDir });
    saveWebBookText({ topic: "Book 2", text: "Book 2\nText 2", fileName: "book2.txt", dir: testDir });
    saveWebBookText({ topic: "Book 3", text: "Book 3\nText 3", fileName: "book3.txt", dir: testDir });
    assert.equal(listPersistedWebBooks(testDir).length, 3);

    const middleware = (await import("../../server/webBookStore.ts")).createWebBookStoreMiddleware(testDir);

    const callApi = async (url: string, method: string) => {
      let code = 0;
      let body = "";
      const req: any = { url, method, headers: {} };
      const res: any = {
        setHeader() {},
        end(data: string) { body = data; },
        set statusCode(c: number) { code = c; },
        get statusCode() { return code; },
      };
      await middleware(req, res, () => {});
      return { code, data: JSON.parse(body || "{}") };
    };

    // Delete single file
    const res1 = await callApi("/api/webbooks/file?name=book1.txt", "DELETE");
    assert.equal(res1.code, 200);
    assert.equal(res1.data.ok, true);
    assert.equal(res1.data.deletedCount, 1);
    assert.equal(fs.existsSync(path.join(testDir, "book1.txt")), false);

    // Reject path traversal attempt on delete
    const resTraversal = await callApi("/api/webbooks/file?name=../evil.txt", "DELETE");
    assert.equal(resTraversal.code, 400);

    // Delete by topic
    const resTopic = await callApi("/api/webbooks/file?topic=Book_2", "DELETE");
    assert.equal(resTopic.code, 200);
    assert.equal(fs.existsSync(path.join(testDir, "book2.txt")), false);

    // Clear all remaining
    const resAll = await callApi("/api/webbooks/all", "DELETE");
    assert.equal(resAll.code, 200);
    assert.equal(resAll.data.ok, true);
    assert.equal(listPersistedWebBooks(testDir).length, 0);
  } finally {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  }
}

console.log("webBookStore tests passed");
