import { isNonJsonResponseText, looksLikeHtml, toPlainTextPreview } from './safeResponse';

export type GeminiFailureReason =
  | 'missing_api_key'
  | 'invalid_api_key'
  | 'permission_denied'
  | 'bad_request'
  | 'quota_daily'
  | 'no_free_tier'
  | 'quota_unspecified'
  | 'quota_or_rate_limit'
  | 'service_unavailable'
  | 'network_unreachable';

/**
 * Failures that retrying (immediately or after a short wait) cannot fix. Used to stop spending requests
 * on a book that cannot be finished, and to say so instead of "please wait a minute".
 */
export const NON_RECOVERABLE_GEMINI_REASONS: ReadonlySet<GeminiFailureReason> = new Set<GeminiFailureReason>([
  'missing_api_key',
  'invalid_api_key',
  'permission_denied',
  'bad_request',
  'quota_daily',
  'no_free_tier',
  'quota_unspecified',
]);

// Disable the client-side Gemini timeout so long-running grounding and
// assembly requests are allowed to complete instead of being cut off early.
export const GEMINI_REQUEST_TIMEOUT_MS = 0;

function tryParseStructuredErrorPayload(input: string): unknown | null {
  const trimmed = input.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function extractStructuredErrorMessage(value: unknown, seen = new Set<unknown>()): string | null {
  if (!value) {
    return null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    const parsed = tryParseStructuredErrorPayload(trimmed);
    if (parsed !== null) {
      return extractStructuredErrorMessage(parsed, seen) || trimmed;
    }

    // An HTML page (proxy/gateway/auth error) or the browser's "Unexpected token '<'" parse
    // error is not a useful message for the user, so summarise it instead of echoing it.
    if (isNonJsonResponseText(trimmed)) {
      const preview = looksLikeHtml(trimmed) ? toPlainTextPreview(trimmed, 120) : '';
      return `The service returned a non-JSON (HTML) response instead of the expected JSON${preview ? ` (${preview})` : ''}.`;
    }

    return trimmed;
  }

  if (typeof value !== 'object') {
    return null;
  }

  if (seen.has(value)) {
    return null;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      const message = extractStructuredErrorMessage(item, seen);
      if (message) {
        return message;
      }
    }

    return null;
  }

  const candidate = value as Record<string, unknown>;
  const fieldsToInspect = [
    candidate.error,
    candidate.message,
    candidate.statusText,
    candidate.details,
    candidate.cause,
  ];

  for (const field of fieldsToInspect) {
    const message = extractStructuredErrorMessage(field, seen);
    if (message) {
      return message;
    }
  }

  return null;
}

function normalizeDisplayErrorText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function buildGeminiUserFacingErrorMessage(
  error: unknown,
  reason: GeminiFailureReason | null = null
): string {
  const detail = extractStructuredErrorMessage(error);
  let baseMessage: string | null = null;

  switch (reason) {
    case 'missing_api_key':
      baseMessage = 'Gemini API key is missing. Set GEMINI_API_KEY or VITE_GEMINI_API_KEY and try again.';
      break;
    case 'invalid_api_key':
      baseMessage = 'Gemini API key was rejected by Google. Check GEMINI_API_KEY or VITE_GEMINI_API_KEY and try again.';
      break;
    case 'permission_denied':
      baseMessage = 'Google refused this request (HTTP 403). The API key may have been revoked, reported as leaked or restricted to other APIs, or the Generative Language API, your account or your region may not be allowed. Create a fresh key in Google AI Studio and check the project status.';
      break;
    case 'bad_request':
      baseMessage = 'Google rejected the request as invalid (HTTP 400). This is a request or configuration problem, not a connection or quota problem.';
      break;
    case 'quota_daily':
      baseMessage = "Gemini's daily quota for this API key's Google project is used up. Quotas are per project (a new key in the same project does not help) and reset at midnight Pacific Time. Wait for the reset, choose another model, or enable billing.";
      break;
    case 'no_free_tier':
      baseMessage = "The selected Gemini model has no quota on this API key's Google project (limit: 0), so waiting will not help. Choose a different model, or enable billing for the project.";
      break;
    case 'quota_unspecified':
      baseMessage = 'Google reports a quota is exhausted but names no limit or retry time. For Google Search grounding this usually means the project has no (or no remaining) grounding allowance, while plain text generation can still work. Check https://ai.dev/rate-limit; another project or billing lifts it, and waiting a minute will not.';
      break;
    case 'quota_or_rate_limit':
      baseMessage = 'Gemini is currently busy or rate-limited. Please wait a minute and try again.';
      break;
    case 'service_unavailable':
      baseMessage = 'Gemini is temporarily unavailable. Please try again shortly.';
      break;
    case 'network_unreachable':
      baseMessage = 'Gemini could not be reached. Please verify your connection and try again.';
      break;
    default:
      baseMessage = null;
      break;
  }

  if (!baseMessage) {
    return detail || 'Unknown Gemini API error';
  }

  if (!detail) {
    return baseMessage;
  }

  const normalizedBase = normalizeDisplayErrorText(baseMessage);
  const normalizedDetail = normalizeDisplayErrorText(detail);
  if (!normalizedDetail || normalizedBase.includes(normalizedDetail) || normalizedDetail.includes(normalizedBase)) {
    return baseMessage;
  }

  return `${baseMessage}\n\nDetails: ${detail}`;
}
