import assert from 'node:assert/strict';
import { LOCAL_HISTORY_KEY, readLocalHistory, writeLocalHistory } from '../../src/services/localHistoryStorage.ts';
import { parseTxtContentToWebBook } from '../../src/services/historyService.ts';

console.warn = () => {};
console.error = () => {};

const globals = globalThis as unknown as Record<string, unknown>;
const install = (storage: unknown) => Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => storage });

// A browser-like store: setItem throws once the total stored characters pass the quota, and leaves the old value alone.
const quotaStore = (quotaChars: number) => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (v.length > quotaChars) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      data.set(k, v);
    },
  };
};
const book = (id: number, size: number) => ({ id: `b${id}`, topic: `t${id}`, timestamp: 1000 - id, body: 'x'.repeat(size) });

// --- 1. Normal round trip ---------------------------------------------------------------------------------------------------
{
  const store = quotaStore(1_000_000);
  install(store);
  const books = [book(1, 100), book(2, 100)];
  assert.equal(writeLocalHistory(books), true);
  assert.deepEqual(readLocalHistory(), books);
}

// --- 2. A full browser store keeps the newest books that fit instead of throwing ---------------------------------------------
{
  const store = quotaStore(2_500); // room for about two of the 1000-character books
  install(store);
  const books = [book(1, 1000), book(2, 1000), book(3, 1000), book(4, 1000), book(5, 1000)]; // newest first
  assert.doesNotThrow(() => writeLocalHistory(books));
  const kept = readLocalHistory() as Array<{ id: string }>;
  assert.ok(kept.length >= 1 && kept.length < books.length, `some, not all, are kept (kept ${kept.length})`);
  assert.deepEqual(kept.map((b) => b.id), books.slice(0, kept.length).map((b) => b.id), 'the newest books are the ones kept');
  // and it is the largest prefix that fits
  const next = JSON.stringify(books.slice(0, kept.length + 1)).length;
  assert.ok(next > 2_500, 'one more book would not have fit');
}

// --- 3. A single book too large for the store: nothing is stored, nothing throws, the old copy survives -----------------------
{
  const store = quotaStore(500);
  store.data.set(LOCAL_HISTORY_KEY, JSON.stringify([book(9, 10)]));
  install(store);
  assert.equal(writeLocalHistory([book(1, 5000)]), false);
  assert.deepEqual((readLocalHistory() as Array<{ id: string }>).map((b) => b.id), ['b9']);
}

// --- 4. Storage that throws on any access (a sandboxed preview frame) or holds junk ---------------------------------------------
{
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { throw new DOMException('Access is denied for this document.', 'SecurityError'); } });
  assert.deepEqual(readLocalHistory(), []);
  assert.equal(writeLocalHistory([book(1, 10)]), false);

  install({ getItem: () => '{not json', setItem: () => {} });
  assert.deepEqual(readLocalHistory(), []);
  install({ getItem: () => '{"not":"an array"}', setItem: () => {} });
  assert.deepEqual(readLocalHistory(), []);

  delete globals.localStorage;
  assert.deepEqual(readLocalHistory(), [], 'no localStorage at all (server-side) is fine');
}

// --- 5. Parsing server-saved .txt files back into WebBooks -------------------------------------------------------------
{
  const txtContent = `MY TOPIC
Generated on: 11/12/2026, 12:00:00 AM

TABLE OF CONTENTS
=================
Chapter 1: Introduction

CHAPTER 1: Introduction
=======================
This is the chapter content text.

CORE CONCEPTS:
- Term A: Description A

SUB-TOPICS:
- Subtopic 1: Summary 1
`;
  const parsed = parseTxtContentToWebBook('2026-11-12_MY_TOPIC.txt', txtContent, 1773000000000);
  assert.ok(parsed !== null);
  assert.equal(parsed.topic, 'MY TOPIC');
  assert.equal(parsed.timestamp, 1773000000000);
  assert.equal(parsed.chapters.length, 1);
  assert.equal(parsed.chapters[0].title, 'Introduction');
  assert.equal(parsed.chapters[0].definitions[0].term, 'Term A');
  assert.equal(parsed.chapters[0].subTopics[0].title, 'Subtopic 1');
}

console.log('localHistoryStorage tests passed');
