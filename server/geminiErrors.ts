/**
 * Classification of errors coming back from the Gemini API.
 *
 * Why this exists: the app used to collapse almost every failure into either "quota/rate limit" or
 * "Gemini could not be reached. Please verify your connection". HTTP 400 (bad request), 403 (key
 * revoked / project blocked / API not enabled) and 500 were all reported as a connectivity problem, and a
 * 429 that can never recover by waiting (daily quota used up, or a model that has no free tier at all)
 * was reported as "busy, wait a minute". This module reads the real status and Google's structured error
 * details so the server, the UI and the diagnostics all say what actually happened.
 */

export type GeminiErrorReason =
  | 'missing_api_key'   // no key configured on the server
  | 'invalid_api_key'   // Google rejected the key (400 API_KEY_INVALID / 401)
  | 'permission_denied' // 403: key restricted/revoked/leaked, API not enabled, region/account not allowed
  | 'model_not_found'   // 404: unknown model, or a model no longer offered to this project
  | 'bad_request'       // other 400: a malformed request or an unsupported parameter combination
  | 'quota_daily'       // 429: a per-day quota is used up; waiting a minute will not help
  | 'no_free_tier'      // 429 with "limit: 0": this model has no quota at all on the project's tier
  | 'quota_unspecified' // 429 with no per-minute/per-day detail at all (seen on Google Search grounding): treated as a standing limit
  | 'rate_limited'      // 429: per-minute request/token limit; clears after a short wait
  | 'overloaded'        // 503: model temporarily overloaded
  | 'internal'          // 500/502/504: transient Google-side failure
  | 'timeout'           // no answer within our per-request limit (slow model); another model should be tried, not the same one
  | 'network';          // the request never got an HTTP answer (DNS, TLS, proxy, reset, offline)

export interface ClassifiedGeminiError {
  httpStatus: number;
  reason: GeminiErrorReason;
  /** The human-readable message Google sent (or the transport error message). */
  message: string;
  /** True when trying the same request again shortly can succeed. */
  retryable: boolean;
  /** Delay Google asked for (RetryInfo.retryDelay or Retry-After), in milliseconds. */
  retryAfterMs: number | null;
}

function tryParseJson(text: unknown): any | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/** "34s", "34.5s", "500ms", 12 (seconds) -> milliseconds. */
export function parseRetryDelayMs(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value * 1000));
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s)?$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  return Math.round(match[2]?.toLowerCase() === 'ms' ? amount : amount * 1000);
}

function collectDetails(body: any): any[] {
  const details = body?.error?.details ?? body?.details;
  return Array.isArray(details) ? details : [];
}

/**
 * Accepts whatever the @google/genai SDK throws (ApiError with a numeric `status` and a JSON string
 * `message`), an already-parsed Google error body, or a transport error such as `TypeError: fetch failed`.
 */
export function classifyGeminiError(err: any): ClassifiedGeminiError {
  const rawMessage = String(err?.message ?? err ?? '');
  const body = tryParseJson(rawMessage) ?? (err && typeof err === 'object' && err.error ? err : null);
  const googleError = body?.error ?? null;

  const numericStatus = Number(err?.status ?? err?.code ?? googleError?.code);
  const httpStatus = Number.isInteger(numericStatus) && numericStatus >= 400 && numericStatus < 600 ? numericStatus : 0;
  const googleStatus = String(googleError?.status ?? (typeof err?.status === 'string' ? err.status : '')).toUpperCase();
  const message = String(googleError?.message ?? rawMessage).trim() || 'Gemini API request failed';
  const lowered = `${message} ${rawMessage}`.toLowerCase();
  const details = collectDetails(body);

  const retryInfo = details.find((d) => /RetryInfo/i.test(String(d?.['@type'] ?? '')));
  const quotaFailure = details.find((d) => /QuotaFailure/i.test(String(d?.['@type'] ?? '')));
  const errorInfo = details.find((d) => /ErrorInfo/i.test(String(d?.['@type'] ?? '')));
  const violations: any[] = Array.isArray(quotaFailure?.violations) ? quotaFailure.violations : [];
  const retryAfterMs = parseRetryDelayMs(retryInfo?.retryDelay) ?? parseRetryDelayMs(err?.retryAfterSeconds);

  const make = (reason: GeminiErrorReason, status: number, retryable: boolean): ClassifiedGeminiError => ({
    httpStatus: httpStatus || status,
    reason,
    message,
    retryable,
    retryAfterMs,
  });

  if (err?.name === 'GeminiTimeoutError') {
    return make('timeout', 504, false);
  }

  if (/missing gemini api key|missing api key|missing_api_key/.test(lowered)) {
    return make('missing_api_key', 401, false);
  }

  if (
    String(errorInfo?.reason ?? '').toUpperCase() === 'API_KEY_INVALID' ||
    /api key not valid|api_key_invalid|invalid api key|api key expired/.test(lowered)
  ) {
    return make('invalid_api_key', httpStatus || 400, false);
  }

  if (httpStatus === 401 || googleStatus === 'UNAUTHENTICATED') {
    return make('invalid_api_key', 401, false);
  }

  if (httpStatus === 403 || googleStatus === 'PERMISSION_DENIED') {
    return make('permission_denied', 403, false);
  }

  if (httpStatus === 404 || googleStatus === 'NOT_FOUND') {
    return make('model_not_found', 404, false);
  }

  if (httpStatus === 429 || googleStatus === 'RESOURCE_EXHAUSTED') {
    const noFreeTier =
      /limit:\s*0\b/.test(lowered) || violations.some((v) => String(v?.quotaValue ?? '') === '0');
    if (noFreeTier) return make('no_free_tier', 429, false);

    const perDay =
      violations.some((v) => /perday|per_day|daily/i.test(`${v?.quotaId ?? ''} ${v?.quotaMetric ?? ''}`)) ||
      /per ?day|daily|requestsperday/.test(lowered);
    if (perDay) return make('quota_daily', 429, false);

    // A per-minute limit normally carries QuotaFailure and/or RetryInfo. A bare RESOURCE_EXHAUSTED with only a help link
    // (observed on every model for googleSearch grounding) names no window and gives no delay, so retrying it is wasted time.
    if (!retryInfo && violations.length === 0) return make('quota_unspecified', 429, false);

    return make('rate_limited', 429, true);
  }

  if (httpStatus === 400 || googleStatus === 'INVALID_ARGUMENT' || googleStatus === 'FAILED_PRECONDITION') {
    // FAILED_PRECONDITION is how Google reports "free tier is not available in your country; enable billing".
    return make('bad_request', 400, false);
  }

  if (httpStatus === 503 || googleStatus === 'UNAVAILABLE') {
    return make('overloaded', 503, true);
  }

  if (httpStatus >= 500 || googleStatus === 'INTERNAL' || googleStatus === 'DEADLINE_EXCEEDED') {
    return make('internal', httpStatus || 500, true);
  }

  // No HTTP answer at all: DNS failure, TLS/proxy problem, connection reset, offline.
  return make('network', 502, true);
}

/** Backoff for attempt number `attempt` (1-based): 1s, 2s, 4s ... capped, plus jitter. */
export function computeBackoffMs(attempt: number, capMs = 32_000, random: () => number = Math.random): number {
  const base = Math.min(capMs, 1000 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base + random() * 500);
}
