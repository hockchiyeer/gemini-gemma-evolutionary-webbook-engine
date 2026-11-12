/**
 * The browser-side copy of the history, kept safe against the two ways browser storage fails: it can be unavailable
 * (a sandboxed preview frame throws on any access to localStorage) and it can be full (about 5 MB, and a few long books
 * fill it). Either failure used to throw out of a React effect with no error boundary above the app, which unmounts
 * the whole page at the moment a book finishes. Storage here is an optimisation, so it must never take the page down.
 */
export const LOCAL_HISTORY_KEY = 'webbook_history';

function getStorage(): Storage | null {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    return storage ?? null;
  } catch {
    return null;
  }
}

/** The stored books, or [] when storage is unavailable, empty or unreadable. Never throws. */
export function readLocalHistory(): unknown[] {
  const storage = getStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(LOCAL_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error('Failed to read local history', error);
    return [];
  }
}

/**
 * Stores the books (newest first). When the browser says it is full, keeps the newest books that fit instead of
 * throwing; the dropped ones stay in the in-memory history and in any server or cloud copy. Returns whether anything
 * was stored. Never throws.
 */
export function writeLocalHistory(books: unknown[]): boolean {
  const storage = getStorage();
  if (!storage) return false;

  const tryWrite = (count: number): boolean => {
    try {
      storage.setItem(LOCAL_HISTORY_KEY, JSON.stringify(books.slice(0, count)));
      return true;
    } catch {
      return false;
    }
  };

  if (tryWrite(books.length)) return true;

  // Largest prefix that fits via binary search. A failed setItem leaves the previous value alone, and successful writes only grow,
  // so the last successful write is the best one.
  let low = 1;
  let high = books.length - 1;
  let best = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (tryWrite(mid)) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (best > 0) {
    console.warn(`Browser storage is full: kept the newest ${best} of ${books.length} books locally.`);
    return true;
  }
  console.warn('Browser storage is full or unavailable: the history was not saved locally.');
  return false;
}
