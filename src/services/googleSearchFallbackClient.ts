import type { SearchFallbackMode, EngineOptions, SearchFallbackPayload, SearchFallbackResult } from '../types';
import { toPlainTextPreview, tryParseJson } from './safeResponse';

const SEARCH_FALLBACK_ROUTE = '/api/search-fallback';
const FALLBACK_FETCH_ATTEMPTS = 3;
// Statuses that are worth retrying even when they come with a JSON error body
// (auth/consent interstitials, cold starts, throttling). Other 4xx JSON errors
// (e.g. "Query is required") are deterministic, so retrying them only adds delay.
const RETRYABLE_CLIENT_STATUSES = new Set([401, 403, 404, 408, 425, 429]);

class FallbackResponseError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'FallbackResponseError';
    this.retryable = retryable;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function buildFallbackModeLabel(mode: SearchFallbackMode): string {
  switch (mode) {
    case 'off':
      return 'Fallback search';
    case 'duckduckgo':
      return 'DuckDuckGo fallback search';
    case 'google':
      return 'Google Search fallback';
    default:
      return 'Google Search + DuckDuckGo fallback search';
  }
}

/**
 * Guarantees the fields downstream code dereferences are present and well-typed,
 * so a structurally odd (but valid JSON) response degrades to the existing
 * "no usable evidence" path instead of throwing a TypeError mid-pipeline.
 * Well-formed payloads pass through unchanged.
 */
function normalizeFallbackPayload(
  raw: Record<string, unknown>,
  query: string,
  mode: SearchFallbackMode
): SearchFallbackPayload {
  const results: SearchFallbackResult[] = (Array.isArray(raw.results) ? raw.results : [])
    .filter((entry): entry is Record<string, unknown> => (
      isRecord(entry) && typeof entry.title === 'string' && typeof entry.url === 'string'
    ))
    .map((entry) => ({
      ...entry,
      snippet: typeof entry.snippet === 'string' ? entry.snippet : '',
    } as unknown as SearchFallbackResult));

  const provider = raw.provider === 'google' || raw.provider === 'duckduckgo' || raw.provider === 'google_duckduckgo'
    ? raw.provider
    : (mode === 'duckduckgo' ? 'duckduckgo' : 'google');

  return {
    ...raw,
    query: typeof raw.query === 'string' && raw.query ? raw.query : query,
    provider,
    results,
    summary: typeof raw.summary === 'string' ? raw.summary : '',
    aiOverview: Array.isArray(raw.aiOverview) ? raw.aiOverview : [],
    diagnostics: Array.isArray(raw.diagnostics)
      ? raw.diagnostics.filter((entry): entry is string => typeof entry === 'string')
      : [],
  } as SearchFallbackPayload;
}

function getFallbackRequestBase(): string {
  if (typeof window !== 'undefined') {
    if (window.location?.origin && window.location.origin !== 'null') {
      return window.location.origin;
    }
    if (window.location?.href && !window.location.href.startsWith('about:')) {
      return window.location.href;
    }
  }
  const port = (typeof process !== 'undefined' && process.env?.PORT) ? process.env.PORT : 3000;
  return `http://127.0.0.1:${port}`;
}

export async function fetchGoogleSearchFallback(
  query: string,
  options: EngineOptions = { mode: 'google_duckduckgo' }
): Promise<SearchFallbackPayload> {
  let lastError: Error | null = null;
  const modeLabel = buildFallbackModeLabel(options.mode);

  if (options.mode === 'off') {
    throw new Error('Fallback search is disabled for this request.');
  }

  for (let attempt = 1; attempt <= FALLBACK_FETCH_ATTEMPTS; attempt += 1) {
    try {
      const requestUrl = new URL(SEARCH_FALLBACK_ROUTE, getFallbackRequestBase());
      requestUrl.searchParams.set('query', query);
      requestUrl.searchParams.set('mode', options.mode);

      // Asking for JSON explicitly stops many dev servers, proxies and auth gateways from
      // answering an API call with their HTML page, and no-store avoids a cached HTML reply.
      const response = await fetch(requestUrl.toString(), {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      const contentType = response.headers.get('content-type') || '';
      // Read the body once as text and parse it ourselves, so a mislabelled content-type
      // never causes valid JSON to be rejected and a bad body never throws a raw SyntaxError.
      const bodyText = await response.text().catch(() => '');
      const parsed = tryParseJson(bodyText);

      if (!response.ok) {
        let errorMessage = `${modeLabel} is currently unavailable.`;

        if (parsed.ok && isRecord(parsed.value) && typeof parsed.value.error === 'string' && parsed.value.error.trim()) {
          errorMessage = parsed.value.error;
        }

        const retryable = !parsed.ok || response.status >= 500 || RETRYABLE_CLIENT_STATUSES.has(response.status);
        throw new FallbackResponseError(errorMessage, retryable);
      }

      if (!parsed.ok || !isRecord(parsed.value)) {
        const preview = toPlainTextPreview(bodyText);
        throw new FallbackResponseError(
          `${modeLabel} returned an invalid response format (expected JSON, got ${contentType || 'an unknown content type'}). `
          + `${preview ? `Preview: ${preview} ` : ''}`
          + 'The search service may still be starting or this host may not be serving the search API route; please try again shortly.',
          true
        );
      }

      return normalizeFallbackPayload(parsed.value, query, options.mode);
    } catch (error) {
      lastError =
        error instanceof Error
          ? error
          : new Error(`${modeLabel} request failed.`);

      const retryable = !(error instanceof FallbackResponseError) || error.retryable;
      if (retryable && attempt < FALLBACK_FETCH_ATTEMPTS) {
        await wait(800 * attempt);
        continue;
      }

      break;
    }
  }

  throw lastError ?? new Error(`${modeLabel} is currently unavailable.`);
}
