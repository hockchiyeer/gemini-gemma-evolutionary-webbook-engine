import type { SearchFallbackPayload, SearchFallbackResult } from '../types.ts';
import { isMeaningfulText, sanitizeNarrativeText } from '../utils/webBookRender.ts';
import { calculateTextSimilarity, countWords, isCjkMajority, splitIntoSentences } from './searchFallbackShared.ts';

function dedupeSentences(text: string, maxSentences = Number.POSITIVE_INFINITY): string[] {
  const unique: string[] = [];

  for (const sentence of splitIntoSentences(text)) {
    const minLen = isCjkMajority(sentence) ? 8 : 35;
    if (sentence.length < minLen) {
      continue;
    }

    if (unique.some((existing) => calculateTextSimilarity(existing, sentence) >= 0.88)) {
      continue;
    }

    unique.push(sentence);
    if (unique.length >= maxSentences) {
      break;
    }
  }

  return unique;
}

function sanitizeFallbackEvidenceText(text: string, maxSentences = 4): string {
  const rawCollapsed = text
    .replace(/\s+/g, ' ')
    .replace(/\.\.\.\s*(?=[A-Z])/g, ' ')
    .trim();
  const cleaned = sanitizeNarrativeText(text)
    .replace(/\s+/g, ' ')
    .replace(/\.\.\.\s*(?=[A-Z])/g, ' ')
    .trim();
  const candidate = cleaned || rawCollapsed;
  const uniqueSentences = dedupeSentences(candidate, maxSentences);

  if (uniqueSentences.length > 0) {
    return uniqueSentences.join(' ');
  }

  return candidate;
}

function buildFallbackResultEvidenceText(result: SearchFallbackResult): string {
  return sanitizeNarrativeText([
    result.excerpt || '',
    result.snippet || '',
  ].join(' ')).replace(/\s+/g, ' ').trim();
}

export function hasUsableFallbackPayloadEvidence(
  payload?: SearchFallbackPayload,
  minWords = 35,
  maxSentences = 12
): boolean {
  if (!payload) {
    return false;
  }

  const summary = sanitizeFallbackEvidenceText(payload.summary, Math.min(6, maxSentences));
  if (countWords(summary) >= minWords && isMeaningfulText(summary)) {
    return true;
  }

  const aggregateEvidence = sanitizeFallbackEvidenceText(
    payload.results.map((result) => buildFallbackResultEvidenceText(result)).join(' '),
    maxSentences
  );

  return countWords(aggregateEvidence) >= minWords && isMeaningfulText(aggregateEvidence);
}
