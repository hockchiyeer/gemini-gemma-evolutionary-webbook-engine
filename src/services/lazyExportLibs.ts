// Loads the export libraries (jspdf, html2canvas) that are imported only when an export button is clicked.
//
// In the Vite dev server used by Google AI Studio these modules are served from /node_modules/.vite/deps/<name>.js?v=<hash>. When Vite
// re-optimises its dependencies while the page is open (a late-discovered dependency, a restart of the preview after an edit), the hash
// the open page knows is outdated and the lazy import fails with "Failed to fetch dynamically imported module". A short retry covers a
// server that is merely busy; if it still fails the page really is stale, and the message tells the user the one thing that fixes it.

export class ExportLibraryLoadError extends Error {
  constructor(library: string, cause: unknown) {
    const reason = String((cause as Error)?.message || cause || 'unknown error').split('\n')[0].slice(0, 160);
    super(
      `The export library "${library}" could not be loaded. The preview server probably refreshed its libraries after this page was opened: ` +
        `reload the page and export again (${reason}).`
    );
    this.name = 'ExportLibraryLoadError';
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Usage: `const { jsPDF } = await loadExportLibrary('jspdf', () => import('jspdf'));` (the import stays literal so Vite can analyse it). */
export async function loadExportLibrary<T>(name: string, load: () => Promise<T>, retries = 2, pauseMs = 800): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await load();
    } catch (err) {
      lastError = err;
      if (attempt < retries) await sleep(pauseMs * (attempt + 1));
    }
  }

  // If the page was open while Vite refreshed its pre-bundled deps, the module specifier's URL in the
  // browser may be stale or cached as rejected. In Vite dev mode, fetch a fresh module directly.
  if (typeof window !== 'undefined' && typeof document !== 'undefined' && Boolean((import.meta as any)?.env?.DEV)) {
    try {
      const dynamicImport = new Function('u', 'return import(u)');
      return await dynamicImport(`/node_modules/.vite/deps/${name}.js?t=${Date.now()}`);
    } catch {
      /* fall through to throw ExportLibraryLoadError */
    }
  }

  throw new ExportLibraryLoadError(name, lastError);
}
