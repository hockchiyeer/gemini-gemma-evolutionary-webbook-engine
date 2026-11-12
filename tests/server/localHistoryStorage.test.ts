import assert from 'node:assert/strict';
import fs from 'node:fs';
import { LOCAL_HISTORY_KEY, readLocalHistory, writeLocalHistory } from '../../src/services/localHistoryStorage.ts';
import { dropKnownServerBooks, parseTxtContentToWebBook } from '../../src/services/historyService.ts';
import { buildWebBookTxtContent } from '../../src/services/exportService.ts';
import type { WebBook } from '../../src/types.ts';

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

// --- 6. dropKnownServerBooks: Deduplication and newest file retention ----------------------------------------------------
{
  const localA: WebBook = {
    id: 'local-1',
    topic: 'Malaysia Politics',
    timestamp: 1000,
    chapters: [{ title: 'Overview', content: 'Detailed rich content', visualSeed: 'img', definitions: [], subTopics: [], sourceUrls: [] }],
  };

  const serverOlderA: WebBook = {
    id: 'server-2026-01-01_Malaysia_Politics',
    topic: 'Malaysia Politics',
    timestamp: 500,
    chapters: [{ title: 'Overview', content: 'Old server content', visualSeed: 'img', definitions: [], subTopics: [], sourceUrls: [] }],
  };

  const serverNewerA: WebBook = {
    id: 'server-2026-01-02_Malaysia_Politics',
    topic: 'Malaysia politics ', // trailing space, different case
    timestamp: 1500,
    chapters: [{ title: 'Overview', content: 'Newer server content', visualSeed: 'img', definitions: [], subTopics: [], sourceUrls: [] }],
  };

  const serverB1: WebBook = {
    id: 'server-2026-01-01_Quantum_Computing',
    topic: 'Quantum Computing',
    timestamp: 800,
    chapters: [{ title: 'Intro', content: 'Server v1', visualSeed: 'img', definitions: [], subTopics: [], sourceUrls: [] }],
  };

  const serverB2: WebBook = {
    id: 'server-2026-01-03_Quantum_Computing',
    topic: 'quantum computing',
    timestamp: 1200,
    chapters: [{ title: 'Intro', content: 'Server v2', visualSeed: 'img', definitions: [], subTopics: [], sourceUrls: [] }],
  };

  // Case A: server books for topic already in knownBooks (localA) are dropped
  // Case B: duplicate server books for new topic (Quantum Computing) are deduped to only keep newest (serverB2)
  const result = dropKnownServerBooks([localA], [serverOlderA, serverNewerA, serverB1, serverB2]);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, serverB2.id);
  assert.equal(result[0].timestamp, 1200);

  // If no known books, both newest topics are kept
  const noKnownResult = dropKnownServerBooks([], [serverOlderA, serverNewerA, serverB1, serverB2]);
  assert.equal(noKnownResult.length, 2);
  const ids = new Set(noKnownResult.map((b) => b.id));
  assert.ok(ids.has(serverNewerA.id));
  assert.ok(ids.has(serverB2.id));
}

// --- 7. Multi-locale round-trip: buildWebBookTxtContent -> parseTxtContentToWebBook -------------------------------------
{
  const locales: Array<{ lang: string; topic: string; ch1: string; ch2: string; term: string; sub: string; sourceTitle: string }> = [
    {
      lang: 'en',
      topic: 'Artificial Intelligence Evolution',
      ch1: 'Foundations and History',
      ch2: 'Modern Architectures',
      term: 'Neural Network',
      sub: 'Deep Learning',
      sourceTitle: 'AI Research Journal',
    },
    {
      lang: 'zh-Hans',
      topic: '马来西亚羽毛球复兴之路',
      ch1: '青训体系改革',
      ch2: '职业化运营与国际竞争',
      term: '梯队建设',
      sub: '科学化训练',
      sourceTitle: '羽毛球运动期刊',
    },
    {
      lang: 'ja',
      topic: '日本の人工知能研究の現在',
      ch1: '自然言語処理の進化',
      ch2: 'ロボティクスと社会実装',
      term: '深層学習',
      sub: 'トランスフォーマー',
      sourceTitle: '日本ロボット学会誌',
    },
  ];

  for (const testCase of locales) {
    const original: WebBook = {
      id: `test-${testCase.lang}`,
      topic: testCase.topic,
      timestamp: 1773000000000,
      chapters: [
        {
          title: testCase.ch1,
          content: `Content of chapter 1 in ${testCase.lang}.\nSecond paragraph of chapter 1.`,
          visualSeed: `${testCase.ch1} visual representation`,
          definitions: [{ term: testCase.term, description: `Definition of ${testCase.term}`, sourceUrl: '' }],
          subTopics: [{ title: testCase.sub, summary: `Summary of ${testCase.sub}`, sourceUrl: '' }],
          sourceUrls: [{ title: testCase.sourceTitle, url: 'https://example.com/paper1' }],
        },
        {
          title: testCase.ch2,
          content: `Content of chapter 2 in ${testCase.lang}.`,
          visualSeed: `${testCase.ch2} visual representation`,
          definitions: [],
          subTopics: [],
          sourceUrls: ['https://example.com/paper2'],
        },
      ],
    };

    const exportedTxt = buildWebBookTxtContent(original);
    const parsed = parseTxtContentToWebBook(`2026-11-12_${testCase.topic}.txt`, exportedTxt, 1773000000000);

    assert.ok(parsed !== null, `Failed to parse exported txt for locale ${testCase.lang}`);
    assert.equal(parsed.topic, testCase.topic.toUpperCase());
    assert.equal(parsed.chapters.length, 2, `Expected 2 chapters for ${testCase.lang}, got ${parsed.chapters.length}`);
    assert.equal(parsed.chapters[0].title, testCase.ch1);
    assert.equal(parsed.chapters[1].title, testCase.ch2);
    assert.ok(parsed.chapters[0].content.includes(`Content of chapter 1 in ${testCase.lang}`));
    assert.equal(parsed.chapters[0].visualSeed, `${testCase.ch1} visual representation`);
    assert.equal(parsed.chapters[0].definitions.length, 1);
    assert.equal(parsed.chapters[0].definitions[0].term, testCase.term);
    assert.equal(parsed.chapters[0].subTopics.length, 1);
    assert.equal(parsed.chapters[0].subTopics[0].title, testCase.sub);
    assert.equal(parsed.chapters[0].sourceUrls.length, 1);
    const src = parsed.chapters[0].sourceUrls[0];
    assert.equal(typeof src === 'object' ? src.url : src, 'https://example.com/paper1');
  }
}

// --- 8. Parse real saved .txt file on disk (6 chapters, sources, no TOC hallucination) -----------------------------------
{
  const realFilePath = 'saved_webbooks/2026-11-12T05-48-23_马来西亚华羽毛球水平复兴之路刍议.txt';
  if (fs.existsSync(realFilePath)) {
    const rawText = fs.readFileSync(realFilePath, 'utf-8');
    const parsed = parseTxtContentToWebBook('2026-11-12T05-48-23_马来西亚华羽毛球水平复兴之路刍议.txt', rawText, 1773000000000);
    assert.ok(parsed !== null);
    assert.equal(parsed.chapters.length, 6, `Expected exactly 6 chapters, got ${parsed.chapters.length}`);
    // Ensure Table of Contents is not counted as a chapter
    assert.ok(!parsed.chapters.some((ch) => /目录|目錄|Table of Contents/i.test(ch.title)));
    // Ensure sources are extracted on chapter 1
    assert.ok(parsed.chapters[0].sourceUrls.length > 0, 'Expected parsed source URLs on chapter 1');
  }
}

console.log('localHistoryStorage tests passed');

