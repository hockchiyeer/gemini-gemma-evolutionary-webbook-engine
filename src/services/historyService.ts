import { initializeApp, type FirebaseApp } from 'firebase/app';
import {
  getAuth,
  onAuthStateChanged,
  signInAnonymously,
  type Auth,
  type User,
} from 'firebase/auth';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  getFirestore,
  orderBy,
  query as firestoreQuery,
  serverTimestamp,
  setDoc,
  writeBatch,
  type Firestore,
} from 'firebase/firestore';
import {
  isSearchFallbackReason,
  isSearchFallbackSource,
  isWebBookSourceMode,
  type SearchFallbackReason,
  type SearchFallbackSource,
  type WebBook,
  type WebBookSourceMode,
} from '../types';
import { buildWebBookTxtContent } from './exportService';
import { readLocalHistory, writeLocalHistory } from './localHistoryStorage';
import { DICTIONARIES } from './exportLabels';

type PersistedSearchStatus = 'started' | 'complete' | 'failed';

interface PersistedSearchRecord {
  query: string;
  status: PersistedSearchStatus;
  timestamp: number;
  error: string | null;
  webBook: WebBook | null;
  createdAt?: unknown;
  updatedAt?: unknown;
}

const getEnvVar = (name: string): string | undefined => {
  try {
    return (import.meta as any)?.env?.[name] ?? (typeof process !== 'undefined' ? process.env?.[name] : undefined);
  } catch {
    return typeof process !== 'undefined' ? process.env?.[name] : undefined;
  }
};

const FIREBASE_CONFIG = {
  apiKey: getEnvVar('VITE_FIREBASE_API_KEY'),
  authDomain: getEnvVar('VITE_FIREBASE_AUTH_DOMAIN'),
  projectId: getEnvVar('VITE_FIREBASE_PROJECT_ID'),
  storageBucket: getEnvVar('VITE_FIREBASE_STORAGE_BUCKET'),
  messagingSenderId: getEnvVar('VITE_FIREBASE_MESSAGING_SENDER_ID'),
  appId: getEnvVar('VITE_FIREBASE_APP_ID'),
  measurementId: getEnvVar('VITE_FIREBASE_MEASUREMENT_ID'),
};

let firebaseApp: FirebaseApp | null = null;
let firebaseAuth: Auth | null = null;
let firebaseDb: Firestore | null = null;
let authInitPromise: Promise<User | null> | null = null;

function isFirebaseConfigured(): boolean {
  const apiKey = FIREBASE_CONFIG.apiKey?.trim();
  const projectId = FIREBASE_CONFIG.projectId?.trim();
  const appId = FIREBASE_CONFIG.appId?.trim();
  const authDomain = FIREBASE_CONFIG.authDomain?.trim();

  if (!apiKey || !projectId || !appId || !authDomain) {
    return false;
  }

  // Reject placeholder and template dummy values
  if (
    apiKey.includes('MY_FIREBASE') ||
    apiKey.includes('YOUR_') ||
    apiKey === 'undefined' ||
    projectId.includes('MY_FIREBASE') ||
    projectId.includes('YOUR_') ||
    appId.includes('MY_FIREBASE')
  ) {
    return false;
  }

  return true;
}

function getFirebaseServices(): { auth: Auth; db: Firestore } | null {
  if (!isFirebaseConfigured()) return null;

  if (!firebaseApp) {
    try {
      firebaseApp = initializeApp(FIREBASE_CONFIG);
      firebaseAuth = getAuth(firebaseApp);
      firebaseDb = getFirestore(firebaseApp);
    } catch (error) {
      console.warn('Firebase initialization failed; falling back to local history storage.', error);
      firebaseApp = null;
      firebaseAuth = null;
      firebaseDb = null;
      return null;
    }
  }

  return { auth: firebaseAuth!, db: firebaseDb! };
}

async function waitForExistingUser(auth: Auth): Promise<User | null> {
  if (auth.currentUser) {
    return auth.currentUser;
  }

  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe = () => {};
    let timer: number | undefined;

    const finish = (user: User | null) => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      unsubscribe();
      resolve(user);
    };

    unsubscribe = onAuthStateChanged(
      auth,
      (user) => finish(user),
      () => finish(auth.currentUser)
    );

    timer = window.setTimeout(() => finish(auth.currentUser), 300);
  });
}

async function ensureAnonymousUser(): Promise<User | null> {
  const services = getFirebaseServices();
  if (!services) return null;

  if (!authInitPromise) {
    authInitPromise = (async () => {
      const existingUser = await waitForExistingUser(services.auth);
      if (existingUser) {
        return existingUser;
      }

      const credential = await signInAnonymously(services.auth);
      return credential.user;
    })().catch((error) => {
      authInitPromise = null;
      console.warn('Firebase persistence auth failed, falling back to local history storage.', error?.message || error);
      return null;
    });
  }

  return authInitPromise;
}

function getSearchesCollection(db: Firestore, userId: string) {
  return collection(db, 'webbookUsers', userId, 'searches');
}

function normalizeWebBook(raw: unknown, fallbackId: string): WebBook | null {
  if (!raw || typeof raw !== 'object') return null;

  const candidate = raw as Partial<WebBook>;
  if (typeof candidate.topic !== 'string' || !Array.isArray(candidate.chapters)) {
    return null;
  }

  return {
    id: typeof candidate.id === 'string' ? candidate.id : fallbackId,
    topic: candidate.topic,
    timestamp: typeof candidate.timestamp === 'number' ? candidate.timestamp : Date.now(),
    chapters: candidate.chapters as WebBook['chapters'],
    completedGenerations: typeof candidate.completedGenerations === 'number' ? candidate.completedGenerations : undefined,
    sourceMode: normalizeSourceMode(candidate.sourceMode),
    generationNote: typeof candidate.generationNote === 'string' ? candidate.generationNote : undefined,
    fallbackSource: normalizeFallbackSource(candidate.fallbackSource),
    fallbackReason: normalizeFallbackReason(candidate.fallbackReason),
  };
}

function normalizeSourceMode(value: unknown): WebBookSourceMode | undefined {
  return isWebBookSourceMode(value) ? value : undefined;
}

function normalizeFallbackSource(value: unknown): SearchFallbackSource | undefined {
  return isSearchFallbackSource(value) ? value : undefined;
}

function normalizeFallbackReason(value: unknown): SearchFallbackReason | undefined {
  return isSearchFallbackReason(value) ? value : undefined;
}

async function updateSearchRecord(searchId: string | null, data: Partial<PersistedSearchRecord>): Promise<void> {
  if (!searchId) return;

  try {
    const services = getFirebaseServices();
    if (!services) return;
    const user = await ensureAnonymousUser();
    if (!user) return;

    await setDoc(
      doc(getSearchesCollection(services.db, user.uid), searchId),
      {
        ...data,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  } catch (error) {
    console.warn('Firebase search update failed (non-fatal):', error);
  }
}

export async function createPersistedSearch(queryText: string): Promise<string | null> {
  try {
    const services = getFirebaseServices();
    if (!services) return null;
    const user = await ensureAnonymousUser();
    if (!user) return null;

    const searchRef = await addDoc(getSearchesCollection(services.db, user.uid), {
      query: queryText,
      status: 'started',
      timestamp: Date.now(),
      error: null,
      webBook: null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    return searchRef.id;
  } catch (error) {
    console.warn('Firebase create search failed (non-fatal):', error);
    return null;
  }
}

export async function completePersistedSearch(searchId: string | null, queryText: string, webBook: WebBook): Promise<void> {
  await updateSearchRecord(searchId, {
    query: queryText,
    status: 'complete',
    timestamp: webBook.timestamp,
    error: null,
    webBook,
  });
}

export async function failPersistedSearch(searchId: string | null, queryText: string, errorMessage: string): Promise<void> {
  await updateSearchRecord(searchId, {
    query: queryText,
    status: 'failed',
    timestamp: Date.now(),
    error: errorMessage,
    webBook: null,
  });
}

export async function loadPersistedWebBooks(): Promise<WebBook[]> {
  try {
    const services = getFirebaseServices();
    if (!services) return [];
    const user = await ensureAnonymousUser();
    if (!user) return [];

    const snapshot = await getDocs(
      firestoreQuery(getSearchesCollection(services.db, user.uid), orderBy('timestamp', 'desc'))
    );

    return snapshot.docs
      .map((searchDoc) => {
        const data = searchDoc.data() as Partial<PersistedSearchRecord>;
        if (data.status !== 'complete' || !data.webBook) {
          return null;
        }

        return normalizeWebBook(data.webBook, searchDoc.id);
      })
      .filter((webBook): webBook is WebBook => Boolean(webBook));
  } catch (error) {
    console.warn('Firebase load history failed (non-fatal):', error);
    return [];
  }
}

export async function deletePersistedSearch(searchId: string): Promise<void> {
  try {
    const services = getFirebaseServices();
    if (!services || !searchId) return;
    const user = await ensureAnonymousUser();
    if (!user) return;

    await deleteDoc(doc(getSearchesCollection(services.db, user.uid), searchId));
  } catch (error) {
    console.warn('Firebase delete search failed (non-fatal):', error);
  }
}

export async function clearPersistedSearches(): Promise<void> {
  try {
    const services = getFirebaseServices();
    if (!services) return;
    const user = await ensureAnonymousUser();
    if (!user) return;

    const snapshot = await getDocs(getSearchesCollection(services.db, user.uid));
    if (snapshot.empty) return;

    // SE-7 fix: Firestore batches are capped at 500 operations; chunk the refs
    // to avoid silent failures when a user has a large search history.
    const BATCH_LIMIT = 500;
    const refs = snapshot.docs.map((searchDoc) => searchDoc.ref);
    for (let start = 0; start < refs.length; start += BATCH_LIMIT) {
      const batch = writeBatch(services.db);
      refs.slice(start, start + BATCH_LIMIT).forEach((ref) => batch.delete(ref));
      await batch.commit();
    }
  } catch (error) {
    console.warn('Firebase clear searches failed (non-fatal):', error);
  }
}

export function mergeHistoryBooks(...historyGroups: WebBook[][]): WebBook[] {
  const historyById = new Map<string, WebBook>();

  historyGroups.flat().forEach((book) => {
    if (!book?.id) return;

    const existing = historyById.get(book.id);
    if (!existing || book.timestamp >= existing.timestamp) {
      historyById.set(book.id, book);
    }
  });

  return Array.from(historyById.values()).sort((a, b) => b.timestamp - a.timestamp);
}

export function loadLocalHistoryBooks(): WebBook[] {
  try {
    return mergeHistoryBooks(readLocalHistory() as WebBook[]);
  } catch (error) {
    console.error('Failed to parse or load local history', error);
    return [];
  }
}

export function saveLocalHistoryBooks(history: WebBook[]): void {
  writeLocalHistory(history);
}

/**
 * Persists a generated WebBook as a formatted .txt file on the server in the saved_webbooks/ folder.
 * Ensures that even if the user never manually downloads or exports, the book is preserved on disk.
 */
export async function persistWebBookTextToServer(webBook: WebBook, textContent?: string): Promise<{ ok: boolean; fileName?: string; filePath?: string }> {
  if (!webBook || !webBook.topic) return { ok: false };
  try {
    const text = textContent || buildWebBookTxtContent(webBook);
    const origin = typeof window !== 'undefined' && window.location?.origin ? window.location.origin : 'http://localhost:3000';
    const res = await fetch(`${origin}/api/webbooks/persist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: webBook.topic,
        text,
        timestamp: webBook.timestamp,
        id: webBook.id,
      }),
    });
    if (!res.ok) return { ok: false };
    return await res.json().catch(() => ({ ok: false }));
  } catch (error) {
    console.warn('Persisting webbook text to server failed (non-fatal):', error);
    return { ok: false };
  }
}

/**
 * Lists all persisted WebBook text files saved on the server.
 */
export async function fetchPersistedWebBooksFromServer(): Promise<Array<{ fileName: string; size: number; modifiedAt: number }>> {
  try {
    const origin = typeof window !== 'undefined' && window.location?.origin ? window.location.origin : 'http://localhost:3000';
    const res = await fetch(`${origin}/api/webbooks/list`);
    if (!res.ok) return [];
    const data = await res.json().catch(() => ({}));
    return Array.isArray(data?.files) ? data.files : [];
  } catch {
    return [];
  }
}

/**
 * Deletes a persisted WebBook text file from the server disk.
 */
export async function deleteServerPersistedWebBook(params: { fileName?: string; topic?: string; id?: string }): Promise<boolean> {
  try {
    const origin = typeof window !== 'undefined' && window.location?.origin ? window.location.origin : 'http://localhost:3000';
    const query = new URLSearchParams();
    if (params.fileName) {
      query.set('name', params.fileName);
    } else if (params.id && params.id.startsWith('server-')) {
      const derived = params.id.replace(/^server-/, '');
      query.set('name', `${derived}.txt`);
    }
    if (params.topic) {
      query.set('topic', params.topic);
    }

    const res = await fetch(`${origin}/api/webbooks/file?${query.toString()}`, {
      method: 'DELETE',
    });
    return res.ok;
  } catch (err) {
    console.warn('Failed to delete server persisted webbook (non-fatal):', err);
    return false;
  }
}

/**
 * Deletes all persisted WebBook text files from the server disk.
 */
export async function clearServerPersistedWebBooks(): Promise<boolean> {
  try {
    const origin = typeof window !== 'undefined' && window.location?.origin ? window.location.origin : 'http://localhost:3000';
    const res = await fetch(`${origin}/api/webbooks/all`, {
      method: 'DELETE',
    });
    return res.ok;
  } catch (err) {
    console.warn('Failed to clear server persisted webbooks (non-fatal):', err);
    return false;
  }
}

const ALL_TOC_LABELS = new Set<string>();
const ALL_VISUAL_LABELS = new Set<string>();
const ALL_CONCEPTS_LABELS = new Set<string>();
const ALL_SUBTOPICS_LABELS = new Set<string>();
const ALL_SOURCES_LABELS = new Set<string>();

for (const d of Object.values(DICTIONARIES)) {
  ALL_TOC_LABELS.add(d.tableOfContents.toLowerCase());
  ALL_VISUAL_LABELS.add(d.visualConcept.toLowerCase());
  ALL_CONCEPTS_LABELS.add(d.coreConcepts.toLowerCase());
  ALL_SUBTOPICS_LABELS.add(d.subTopics.toLowerCase());
  ALL_SOURCES_LABELS.add(d.sources.toLowerCase());
}

function matchSectionHeader(line: string): { type: 'visual'; value?: string } | { type: 'concepts' | 'subtopics' | 'sources' } | null {
  const trimmed = line.trim();
  const lower = trimmed.toLowerCase();

  for (const label of ALL_VISUAL_LABELS) {
    if (lower.startsWith(label + ':') || lower.startsWith(label + '：')) {
      const colonIdx = line.indexOf(':') !== -1 ? line.indexOf(':') : line.indexOf('：');
      return { type: 'visual', value: line.slice(colonIdx + 1).trim() };
    }
  }

  const withoutColon = lower.replace(/[:：]\s*$/, '').trim();
  if (ALL_CONCEPTS_LABELS.has(withoutColon)) return { type: 'concepts' };
  if (ALL_SUBTOPICS_LABELS.has(withoutColon)) return { type: 'subtopics' };
  if (ALL_SOURCES_LABELS.has(withoutColon)) return { type: 'sources' };

  return null;
}

export function parseTxtContentToWebBook(fileName: string, text: string, modifiedAt?: number): WebBook | null {
  if (!text || !text.trim()) return null;
  const lines = text.split('\n');
  const firstLine = lines[0]?.trim() || '';
  const topic = (firstLine || fileName.replace(/\.txt$/i, '').replace(/^[0-9T-]*_/, '').replace(/_/g, ' ')).trim();

  // Find all underlined headings: heading line followed by ===...
  const headingRegex = /(?:^|\n)([^\n]+)\n={3,}(?:\n|$)/g;
  const sections: Array<{ heading: string; start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = headingRegex.exec(text)) !== null) {
    sections.push({ heading: m[1].trim(), start: m.index, end: headingRegex.lastIndex });
  }

  const chapterPrefixRegex = /^(?:CHAPTER|BAB|CAPÍTULO|CAPITULO|CHAPITRE|KAPITEL|第\s*\d+\s*章|제\s*\d+\s*장)\b|^(?:第\s*\d+\s*章|제\s*\d+\s*장)/i;
  const hasPrefixedChapters = sections.some((s) => !ALL_TOC_LABELS.has(s.heading.toLowerCase()) && chapterPrefixRegex.test(s.heading));

  const chapters: WebBook['chapters'] = [];
  for (let i = 0; i < sections.length; i++) {
    const headerLine = sections[i].heading;
    // Skip Table of Contents heading and anything before actual chapters
    if (ALL_TOC_LABELS.has(headerLine.toLowerCase())) {
      continue;
    }
    // Prevent phantom chapters from body text followed by === when prefixed chapters exist
    if (hasPrefixedChapters && !chapterPrefixRegex.test(headerLine)) {
      continue;
    }

    const colonIdx = headerLine.indexOf(':') !== -1 ? headerLine.indexOf(':') : headerLine.indexOf('：');
    let title = colonIdx !== -1 ? headerLine.slice(colonIdx + 1).trim() : headerLine.trim();
    if (colonIdx === -1) {
      title = title.replace(/^(?:CHAPTER|BAB|CAPÍTULO|CAPITULO|CHAPITRE|KAPITEL|第\s*\d+\s*章|제\s*\d+\s*장)\s*\d*[:：\s]\s*/i, '').trim();
    }
    if (!title) title = headerLine.trim();

    const bodyStart = sections[i].end;
    const bodyEnd = i + 1 < sections.length ? sections[i + 1].start : text.length;
    const body = text.slice(bodyStart, bodyEnd).trim();
    const bodyLines = body.split('\n');

    let currentSection: 'content' | 'concepts' | 'subtopics' | 'sources' = 'content';
    const contentLines: string[] = [];
    const defLines: string[] = [];
    const subTopicLines: string[] = [];
    const sourceLines: string[] = [];
    let visualSeed = title;

    for (const rawLine of bodyLines) {
      const line = rawLine.trim();
      const header = matchSectionHeader(line);
      if (header) {
        if (header.type === 'visual') {
          if (header.value) visualSeed = header.value;
        } else {
          currentSection = header.type;
        }
        continue;
      }

      if (currentSection === 'content') {
        const trimmedLine = rawLine.trim();
        // Ignore orphan divider lines (e.g. ==================== or --------------------)
        if (!/^\s*[=_\-]{3,}\s*$/.test(trimmedLine)) {
          contentLines.push(rawLine);
        }
      } else if (currentSection === 'concepts') {
        if (line.startsWith('-')) defLines.push(line);
      } else if (currentSection === 'subtopics') {
        if (line.startsWith('-')) subTopicLines.push(line);
      } else if (currentSection === 'sources') {
        if (line.startsWith('-')) sourceLines.push(line);
      }
    }

    const definitions: NonNullable<WebBook['chapters'][0]['definitions']> = [];
    for (const dl of defLines) {
      const clean = dl.replace(/^-+\s*/, '').trim();
      const match = clean.match(/^(.*?)[：:]\s*(.*)$/);
      if (match) {
        definitions.push({ term: match[1].trim(), description: match[2].trim(), sourceUrl: '' });
      }
    }

    const subTopics: NonNullable<WebBook['chapters'][0]['subTopics']> = [];
    for (const st of subTopicLines) {
      const clean = st.replace(/^-+\s*/, '').trim();
      const match = clean.match(/^(.*?)[：:]\s*(.*)$/);
      if (match) {
        subTopics.push({ title: match[1].trim(), summary: match[2].trim(), sourceUrl: '' });
      }
    }

    const sourceUrls: NonNullable<WebBook['chapters'][0]['sourceUrls']> = [];
    for (const sl of sourceLines) {
      const clean = sl.replace(/^-+\s*/, '').trim();
      const urlMatch = clean.match(/^(.*?)\s*-\s*(https?:\/\/\S+)$/);
      if (urlMatch) {
        const titlePart = urlMatch[1].trim();
        const url = urlMatch[2].trim();
        const hostMatch = titlePart.match(/^(.*?)\s*\(([^)]+)\)$/);
        const cleanTitle = hostMatch ? hostMatch[1].trim() : titlePart;
        sourceUrls.push({ title: cleanTitle || url, url });
      } else if (/https?:\/\/\S+/.test(clean)) {
        const directUrlMatch = clean.match(/https?:\/\/\S+/);
        const directUrl = directUrlMatch ? directUrlMatch[0] : clean;
        const title = clean.replace(directUrl, '').replace(/^[-—:\s]+|[-—:\s]+$/g, '').trim() || directUrl;
        sourceUrls.push({ title, url: directUrl });
      }
    }

    const chapterContent = contentLines.join('\n').replace(/^[=_\-\s]+$/gm, '').trim();
    // Skip empty phantom chapters with no content, definitions, subtopics or sources
    if (!chapterContent && definitions.length === 0 && subTopics.length === 0 && sourceUrls.length === 0) {
      continue;
    }

    chapters.push({
      title,
      content: chapterContent,
      visualSeed,
      definitions,
      subTopics,
      sourceUrls,
    });
  }

  // Filter out TOC hallucination chapters (short chapters whose content is just a list of other chapter titles)
  const allParsedTitles = chapters.map((c) => c.title.toLowerCase().replace(/[\s:：、，,.\-—–_]+/g, ''));
  const cleanedChapters = chapters.filter((ch) => {
    const contentNorm = ch.content.toLowerCase().replace(/[\s:：、，,.\-—–_]+/g, '');
    let hitCount = 0;
    for (const t of allParsedTitles) {
      if (t.length > 4 && contentNorm.includes(t)) {
        hitCount++;
      }
    }
    if (hitCount >= 2 && ch.content.length < 350 && ch.definitions.length === 0 && ch.subTopics.length === 0) {
      return false;
    }
    return true;
  });

  // Ensure 100% unique chapter titles across the book
  const seenTitleCount = new Map<string, number>();
  const finalChapters = (cleanedChapters.length > 0 ? cleanedChapters : chapters).map((ch) => {
    const normKey = ch.title.toLowerCase().replace(/[\s:：、，,.\-—–_]+/g, '');
    const count = seenTitleCount.get(normKey) || 0;
    seenTitleCount.set(normKey, count + 1);
    let finalTitle = ch.title;
    if (count > 0) {
      finalTitle = `${ch.title} (Part ${count + 1})`;
    }
    return {
      ...ch,
      title: finalTitle,
    };
  });

  const timestamp = modifiedAt || Date.now();
  const id = `server-${fileName.replace(/[^a-zA-Z0-9_-]/g, '-')}`;

  return {
    id,
    topic,
    timestamp,
    chapters: finalChapters.length > 0 ? finalChapters : [{
      title: topic,
      content: text,
      visualSeed: topic,
      definitions: [],
      subTopics: [],
      sourceUrls: [],
    }],
    sourceMode: 'fallback_search',
  };
}

/**
 * Deduplicates rehydrated server books against existing (local/cloud) history:
 * 1. Keeps only the newest server book per topic.
 * 2. If a book with the same topic (or ID) is already in knownBooks, drops the server copy
 *    to preserve the richer local copy and avoid duplicate entries in the History Drawer.
 */
export function dropKnownServerBooks(knownBooks: WebBook[], serverBooks: WebBook[]): WebBook[] {
  const newestServerByTopic = new Map<string, WebBook>();
  for (const book of serverBooks) {
    if (!book || !book.topic) continue;
    const key = book.topic.trim().toLowerCase();
    const existing = newestServerByTopic.get(key);
    if (!existing || (book.timestamp ?? 0) > (existing.timestamp ?? 0)) {
      newestServerByTopic.set(key, book);
    }
  }

  const knownTopics = new Set<string>();
  const knownIds = new Set<string>();
  for (const book of knownBooks) {
    if (!book) continue;
    if (book.id) knownIds.add(book.id);
    if (book.topic) knownTopics.add(book.topic.trim().toLowerCase());
  }

  const result: WebBook[] = [];
  for (const book of newestServerByTopic.values()) {
    const key = book.topic.trim().toLowerCase();
    if (knownTopics.has(key) || knownIds.has(book.id)) {
      continue;
    }
    result.push(book);
  }

  return result;
}

/**
 * Hydrates WebBooks from .txt files stored on the server saved_webbooks/ directory.
 * Ensures books are restored on browser page refresh even when localStorage is empty.
 */
export async function loadServerPersistedWebBooks(): Promise<WebBook[]> {
  try {
    const files = await fetchPersistedWebBooksFromServer();
    if (files.length === 0) return [];

    const origin = typeof window !== 'undefined' && window.location?.origin ? window.location.origin : 'http://localhost:3000';
    const books: WebBook[] = [];

    for (const file of files) {
      try {
        const res = await fetch(`${origin}/api/webbooks/file?name=${encodeURIComponent(file.fileName)}`);
        if (!res.ok) continue;
        const text = await res.text();
        const parsed = parseTxtContentToWebBook(file.fileName, text, file.modifiedAt);
        if (parsed) {
          books.push(parsed);
        }
      } catch {
        // Continue loading remaining files
      }
    }

    return books;
  } catch {
    return [];
  }
}
