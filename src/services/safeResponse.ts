/**
 * Small, dependency-free helpers for handling responses that were expected to be
 * JSON but arrived as something else (an HTML SPA fallback, a proxy/auth/consent
 * interstitial, a gateway error page, a mislabelled content-type, ...).
 */

const HTML_DOCUMENT_PATTERN = /<!doctype\s+html|<html[\s>]|<\/?(?:head|body|title)[\s>]/i;
const JSON_PARSE_ERROR_PATTERN = /unexpected token\s*'?<|is not valid json|unexpected end of json|<!doctype/i;

export type JsonParseOutcome = { ok: true; value: unknown } | { ok: false };

/** Parses JSON regardless of the response's content-type header. Never throws. */
export function tryParseJson(text: string): JsonParseOutcome {
  const cleaned = text.replace(/^\uFEFF/, '').trim();
  if (!cleaned) {
    return { ok: false };
  }

  try {
    return { ok: true, value: JSON.parse(cleaned) as unknown };
  } catch {
    return { ok: false };
  }
}

export function looksLikeHtml(text: string): boolean {
  return HTML_DOCUMENT_PATTERN.test(text.slice(0, 4000));
}

/** True for raw HTML bodies and for the browser's "Unexpected token '<' ... is not valid JSON" errors. */
export function isNonJsonResponseText(text: string): boolean {
  return looksLikeHtml(text) || JSON_PARSE_ERROR_PATTERN.test(text.slice(0, 4000));
}

/** Reduces an HTML (or any) body to a short, single-line, tag-free preview that is safe to show. */
export function toPlainTextPreview(text: string, maxLength = 160): string {
  const plain = text
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;|&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();

  return plain.length > maxLength ? `${plain.slice(0, maxLength).trimEnd()}...` : plain;
}
