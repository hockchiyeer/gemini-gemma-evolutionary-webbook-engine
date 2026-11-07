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

const LOCAL_HISTORY_KEY = 'webbook_history';

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

const FIREBASE_CONFIG = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
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
  const savedHistory = localStorage.getItem(LOCAL_HISTORY_KEY);
  if (!savedHistory) return [];

  try {
    return mergeHistoryBooks(JSON.parse(savedHistory) as WebBook[]);
  } catch (error) {
    console.error('Failed to parse local history', error);
    return [];
  }
}

export function saveLocalHistoryBooks(history: WebBook[]): void {
  localStorage.setItem(LOCAL_HISTORY_KEY, JSON.stringify(history));
}
