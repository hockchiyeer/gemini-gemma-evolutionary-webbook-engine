import {
  Chapter,
  Definition,
  EngineOptions,
  GEMINI_MODELS,
  SearchFallbackMode,
  SearchFallbackPayload,
  SearchFallbackReason,
  SubTopic,
  Type,
  WebBook,
  WebBookSourceMode,
  WebPageGenotype,
} from "../types";
import { fetchGoogleSearchFallback } from "./googleSearchFallbackClient";
import { clipLabelAtWordBoundary, summarizeTitle } from "./documentTitle";
import { buildGeminiUserFacingErrorMessage, GeminiFailureReason, NON_RECOVERABLE_GEMINI_REASONS } from "./geminiUserFacingErrors";
import { isNonJsonResponseText } from "./safeResponse";
import {
  SYNTHETIC_FALLBACK_DIAGNOSTIC,
  calculateTextSimilarity,
  classifySourceReliability,
  countWords,
  describeFallbackEvidence,
  isSyntheticFallbackPayload,
  isValidConceptDefinition,
  normalizeCjkSpacing,
  stripSnippetSplices,
} from "./searchFallbackShared";
import { BOOK_CHAPTER_COUNT, cleanChapterContent, cleanTermLabel } from './modelTextCleanup';
import {
  CHAPTER_NUMBER_PREFIX,
  MIN_CHAPTER_TEXT_PAGES,
  containsPoisonBoilerplate,
  getRenderableDefinitions,
  getRenderableSubTopics,
  isPageChromeText,
  joinSentences,
  looksLikeAssemblyCode,
  sanitizeNarrativeText,
  splitIntoSentences,
} from "../utils/webBookRender";

export function buildSyntheticFallbackPayload(query: string, mode: SearchFallbackMode = 'google_duckduckgo'): SearchFallbackPayload {
  const provider = mode === 'duckduckgo' ? 'duckduckgo' : 'google';
  return {
    query,
    provider,
    summary: `Structured overview for ${query}.`,
    aiOverview: [],
    results: [
      {
        title: `${query} Overview`,
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(query.replace(/\s+/g, '_'))}`,
        snippet: `Comprehensive overview, historical background, and fundamental principles of ${query}.`,
        domain: 'wikipedia.org',
      },
    ],
    extractedAt: Date.now(),
    diagnostics: [SYNTHETIC_FALLBACK_DIAGNOSTIC],
  };
}

// How many evolved source pages are handed to book assembly.
export const ASSEMBLY_SOURCE_POOL_SIZE = 8;

// Chapter size asked of Gemini.
export const CHAPTER_TARGET_WORDS = { min: 700, max: 900 } as const;
// A chapter shorter than this is treated as a failed chapter, never padded with filler.
const MIN_ACCEPTABLE_CHAPTER_WORDS = 120;
// Simultaneous chapter requests.
export const CHAPTER_CONCURRENCY = 3;
const EVIDENCE_CHARS_PER_SOURCE = 1500;
const EVIDENCE_TOTAL_CHAR_BUDGET = 12000;
const MIN_EVOLVED_SOURCES = 6;

// evolve() offspring only recombine their parents' text, so they carry no evidence of their own.
const OFFSPRING_ID_PREFIX = 'offspring-';

const CANDIDATE_MODELS = [
  ...GEMINI_MODELS,
];

const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash';

function getApiEndpoint(path: string): string {
  if (typeof window !== 'undefined' && window.location?.origin) {
    return `${window.location.origin}${path}`;
  }
  return `http://localhost:3000${path}`;
}

async function withRetry<T>(fn: () => Promise<T>, retries = 3, delay = 1000): Promise<T> {
  try {
    return await fn();
  } catch (error: any) {
    const message = String(error?.message || error?.statusText || error || '').toLowerCase();
    const status = Number(error?.status || error?.code);
    const isRetryable =
      retries > 0 &&
      (status === 429 ||
        status === 503 ||
        status === 500 ||
        status === 502 ||
        status === 504 ||
        message.includes('429') ||
        message.includes('503') ||
        message.includes('quota') ||
        message.includes('resource_exhausted') ||
        message.includes('unavailable') ||
        message.includes('high demand'));

    const isDailyQuotaExhausted = message.includes('per day limit exceeded') || message.includes('retry in ');
    if (isDailyQuotaExhausted) {
      throw error;
    }

    if (isRetryable) {
      const waitTime = delay + Math.random() * 400;
      await new Promise((resolve) => setTimeout(resolve, waitTime));
      return withRetry(fn, retries - 1, delay * 2);
    }
    throw error;
  }
}

function repairTruncatedJSON(jsonString: string): string {
  let stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < jsonString.length; i++) {
    const char = jsonString[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === '{' || char === '[') {
      stack.push(char);
    } else if (char === '}' || char === ']') {
      if (stack.length > 0) {
        const last = stack[stack.length - 1];
        if ((char === '}' && last === '{') || (char === ']' && last === '[')) {
          stack.pop();
        }
      }
    }
  }

  let repaired = jsonString;
  if (inString) {
    repaired += '"';
  }

  while (stack.length > 0) {
    const last = stack.pop();
    if (last === '{') repaired += '}';
    else if (last === '[') repaired += ']';
  }

  return repaired;
}

function detectGeminiFailureReason(err: any): GeminiFailureReason {
  const message = String(err?.message || err?.statusText || err || '').toLowerCase();
  const status = Number(err?.status || err?.code);
  const reason = String(err?.reason || err?.details?.reason || err?.error?.reason || '').toLowerCase();

  if (status === 401 || message.includes('api_key_invalid') || message.includes('unauthenticated') || message.includes('invalid api key')) {
    return 'invalid_api_key';
  }
  if (message.includes('missing api key') || message.includes('missing_api_key')) {
    return 'missing_api_key';
  }
  if (status === 403 || reason === 'permission_denied' || message.includes('permission_denied') || message.includes('403')) {
    return 'permission_denied';
  }
  if (reason === 'no_free_tier' || message.includes('no_free_tier')) {
    return 'no_free_tier';
  }
  if (reason === 'quota_unspecified' || message.includes('quota_unspecified')) {
    return 'quota_unspecified';
  }
  if (
    reason === 'quota_daily' ||
    reason === 'quota_exceeded' ||
    message.includes('daily quota') ||
    message.includes('per day limit')
  ) {
    return 'quota_daily';
  }
  if (status === 429 || message.includes('429') || message.includes('quota') || message.includes('resource_exhausted')) {
    return 'quota_or_rate_limit';
  }
  if (status === 503 || message.includes('503') || message.includes('unavailable')) {
    return 'service_unavailable';
  }
  // An HTML page where JSON was expected (proxy/gateway/auth page) means the service is
  // reachable but not answering properly, which is not a connectivity problem on the user's side.
  if (isNonJsonResponseText(String(err?.message || err?.statusText || err || ''))) {
    return 'service_unavailable';
  }
  return 'network_unreachable';
}

// Calls Gemini via server endpoint with the user's selected model, failing over to active sibling Flash models
// if the selected model experiences a temporary 503 high demand spike or 404 deprecation.
async function generateWithModelFallback(
  requestParams: any,
  preferredModel?: string
): Promise<any> {
  const primaryModel = preferredModel || DEFAULT_GEMINI_MODEL;
  const candidateModels = [
    primaryModel,
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
    'gemini-3.7-flash',
    'gemini-3.8-flash',
    'gemini-flash-lite-latest',
  ].filter((m, idx, arr) => arr.indexOf(m) === idx).slice(0, 3);

  let lastError: any = null;

  for (const model of candidateModels) {
    try {
      const data = await withRetry(async () => {
        const endpoint = getApiEndpoint('/api/gemini/generate');
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            ...requestParams,
          }),
        });

        const resData = await res.json().catch(() => ({}));

        if (!res.ok) {
          const errorObj: any = new Error(resData?.error?.message || `Gemini request failed with status ${res.status}`);
          errorObj.status = res.status;
          errorObj.code = resData?.error?.code || res.status;
          errorObj.reason = resData?.error?.reason;
          errorObj.details = resData?.error?.details;
          throw errorObj;
        }

        return resData;
      });

      if (typeof data === 'object' && data !== null) {
        // A local model reports itself (modelUsed: "gemma4:e4b (local)"), so the book's notes name what really wrote it.
        data._modelUsed = typeof data.modelUsed === 'string' && data.modelUsed ? data.modelUsed : model;
      }
      return data;
    } catch (err: any) {
      lastError = err;
      const status = Number(err?.status || err?.code);
      const message = String(err?.message || '').toLowerCase();
      const reason = detectGeminiFailureReason(err);

      if (NON_RECOVERABLE_GEMINI_REASONS.has(reason) && reason !== 'quota_daily' && reason !== 'quota_unspecified') {
        throw err;
      }

      const isUnavailableOrQuota =
        status === 429 ||
        status === 503 ||
        status === 404 ||
        status === 500 ||
        status === 502 ||
        status === 504 ||
        message.includes('429') ||
        message.includes('quota') ||
        message.includes('resource_exhausted') ||
        message.includes('503') ||
        message.includes('unavailable') ||
        message.includes('high demand') ||
        message.includes('not found') ||
        message.includes('no longer available');

      if (isUnavailableOrQuota && model !== candidateModels[candidateModels.length - 1]) {
        console.warn(`Model ${model} was unavailable or reached per-model quota (${status || message}), attempting failover with next Flash model...`);
        continue;
      }

      throw err;
    }
  }

  throw lastError;
}

export function isMeaningful(text: string, description?: string): boolean {
  if (!text) return false;
  const clean = text.replace(/\s/g, '');
  const lowerText = text.toLowerCase();
  const lowerDesc = (description || '').toLowerCase();

  const cjkMatches = clean.match(/[\u1100-\u11ff\u2e80-\ua4cf\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/g);
  const isCjk = cjkMatches ? cjkMatches.length >= 2 : false;

  // Filter out pure digits
  if (/^\d+$/.test(clean)) return false;
  // Filter out long sequences of identical characters
  if (/(.)\1{8,}/.test(clean)) return false;
  // Filter out strings with more than 10 consecutive digits
  if (/\d{10,}/.test(clean)) return false;
  // Filter out very long ASCII strings without spaces (likely code, tokens or IDs)
  if (!isCjk && text.length > 40 && !text.includes(' ')) return false;
  // Filter out ASCII strings that look like random hex/alphanumeric (no vowels and long)
  if (!isCjk && clean.length > 12 && !/[aeiou]/i.test(clean)) return false;

  // Filter out generic placeholder concepts like "Concept 1", "Concept 2"
  if (/^concept\s*\d*$/i.test(text.trim())) return false;
  // Filter out text or description that looks like a URL slug or path
  if (/\b(?:com|org|net|edu|gov|io|my|sg|co)\/[a-z0-9_./-]+\b/i.test(text) || /\b(?:com|org|net|edu|gov|io|my|sg|co)\/[a-z0-9_./-]+\b/i.test(description || '')) return false;
  if (/^[a-z0-9_-]+\/[a-z0-9_./-]*$/i.test(clean)) return false;
  if (clean.includes('/') && !text.includes(' ')) return false;
  if (description && description.includes('/') && !description.includes(' ')) return false;

  // Anti-poisoning & copyright boilerplate filters (shared with the render-time check so both agree)
  if (containsPoisonBoilerplate(text, description)) return false;

  // Filter out raw assembly or machine code listings (not the English words "call", "add", "pop", ...)
  if (looksLikeAssemblyCode(text) || looksLikeAssemblyCode(description)) return false;
  if (/[0-9a-f]{2,}\s[0-9a-f]{2,}\s[0-9a-f]{2,}/i.test(text)) return false;

  return true;
}

export async function discoverAvailableGeminiModels(): Promise<string[]> {
  return [...CANDIDATE_MODELS];
}

export interface SearchExtractionResult {
  results: WebPageGenotype[];
  artifacts: {
    groundingChunks?: any[];
    searchSummary?: string;
  };
  generationNote?: string;
  sourceMode: WebBookSourceMode;
  fallbackSource?: any;
  fallbackReason?: SearchFallbackReason;
}

interface VerifiedGroundingSource {
  uri: string;
  title: string;
  domain: string;
}

function extractVerifiedGroundingSources(response: any): VerifiedGroundingSource[] {
  const chunks = response?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  const verified: VerifiedGroundingSource[] = [];

  for (const c of chunks) {
    const uri = String(c?.web?.uri || c?.uri || '').trim();
    const title = String(c?.web?.title || c?.title || '').trim();
    if (uri && /^https?:\/\//i.test(uri)) {
      try {
        const parsed = new URL(uri);
        const domain = parsed.hostname.replace(/^www\./i, '').toLowerCase();
        if (!verified.some(v => v.uri === uri)) {
          verified.push({ uri, title, domain });
        }
      } catch {
        // ignore invalid URL
      }
    }
  }

  return verified;
}

function resolveVerifiedSource(
  rawItem: any,
  index: number,
  verifiedSources: VerifiedGroundingSource[]
): { url: string; title: string } {
  const rawUrl = String(rawItem?.url || '').trim();
  const rawTitle = String(rawItem?.title || '').trim();

  // 1. Direct URL match with verified grounding
  const directMatch = verifiedSources.find(v => v.uri === rawUrl);
  if (directMatch) {
    return { url: directMatch.uri, title: directMatch.title || rawTitle };
  }

  // 2. Domain and path matching against verified grounding
  if (rawUrl && /^https?:\/\//i.test(rawUrl)) {
    try {
      const parsedRaw = new URL(rawUrl);
      const rawDomain = parsedRaw.hostname.replace(/^www\./i, '').toLowerCase();
      const domainMatches = verifiedSources.filter(v => v.domain === rawDomain);

      if (domainMatches.length === 1) {
        return { url: domainMatches[0].uri, title: domainMatches[0].title || rawTitle };
      }

      if (domainMatches.length > 1) {
        const rawWords = parsedRaw.pathname.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2);
        let best = domainMatches[0];
        let bestScore = -1;
        for (const candidate of domainMatches) {
          const candWords = new URL(candidate.uri).pathname.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2);
          const score = rawWords.filter(w => candWords.includes(w)).length;
          if (score > bestScore) {
            bestScore = score;
            best = candidate;
          }
        }
        return { url: best.uri, title: best.title || rawTitle };
      }
    } catch {
      // not a valid URL
    }
  }

  // 3. Match by title similarity against verified grounding
  if (rawTitle && verifiedSources.length > 0) {
    const rawLower = rawTitle.toLowerCase();
    const titleMatch = verifiedSources.find(v => 
      v.title && (v.title.toLowerCase().includes(rawLower) || rawLower.includes(v.title.toLowerCase()))
    );
    if (titleMatch) {
      return { url: titleMatch.uri, title: titleMatch.title };
    }
  }

  // 4. Align by index with verified grounding sources
  if (index < verifiedSources.length) {
    return { url: verifiedSources[index].uri, title: verifiedSources[index].title || rawTitle };
  }

  // 5. Pick from verified grounding if available
  if (verifiedSources.length > 0) {
    const picked = verifiedSources[index % verifiedSources.length];
    return { url: picked.uri, title: picked.title || rawTitle };
  }

  if (rawUrl && /^https?:\/\//i.test(rawUrl)) {
    try {
      const u = new URL(rawUrl);
      if (!u.hostname.includes('source-') && u.hostname !== 'knowledge-base.org') {
        return { url: rawUrl, title: rawTitle || 'Source Article' };
      }
    } catch {
      // ignore
    }
  }

  return { url: '', title: rawTitle || 'Source Article' };
}

// Why the Gemini search step did not supply the evidence (drives the notice and fallbackReason).
type GeminiSearchCause = GeminiFailureReason | 'no_content' | 'model_unavailable';

const GEMINI_SEARCH_CAUSE_PHRASES: Record<GeminiSearchCause, string> = {
  quota_or_rate_limit: 'usage limit reached',
  invalid_api_key: 'API key rejected',
  missing_api_key: 'API key missing',
  permission_denied: 'permission denied',
  bad_request: 'invalid request',
  quota_daily: 'daily quota exhausted',
  no_free_tier: 'no quota for this model',
  quota_unspecified: 'quota exhausted, no detail from Google',
  service_unavailable: 'service temporarily unavailable',
  network_unreachable: 'could not be reached',
  no_content: 'no usable sources returned',
  model_unavailable: 'model not available',
};

const GEMINI_SEARCH_CAUSE_TO_FALLBACK_REASON: Record<GeminiSearchCause, SearchFallbackReason> = {
  quota_or_rate_limit: 'quota_exhausted',
  invalid_api_key: 'unreachable',
  missing_api_key: 'unreachable',
  permission_denied: 'unreachable',
  bad_request: 'unreachable',
  quota_daily: 'quota_exhausted',
  no_free_tier: 'quota_exhausted',
  quota_unspecified: 'quota_exhausted',
  service_unavailable: 'unreachable',
  network_unreachable: 'network_unreachable',
  no_content: 'no_content',
  model_unavailable: 'unreachable',
};

function classifyGeminiSearchFailure(err: any): GeminiSearchCause {
  const message = String(err?.message || err || '');
  // Gemini answered but its text could not be parsed (e.g. cut off): a content problem, not an outage.
  if (err instanceof SyntaxError && !/<|doctype/i.test(message)) {
    return 'no_content';
  }
  const lowered = message.toLowerCase();
  if (
    Number(err?.status || err?.code) === 404 ||
    lowered.includes('not found') ||
    lowered.includes('is not supported') ||
    lowered.includes('unknown model')
  ) {
    return 'model_unavailable';
  }
  return detectGeminiFailureReason(err);
}

function describeFallbackProviders(mode: SearchFallbackMode): string {
  switch (mode) {
    case 'google':
      return 'The Google fallback search';
    case 'duckduckgo':
      return 'The DuckDuckGo fallback search';
    default:
      return 'The Google and DuckDuckGo fallback searches';
  }
}

// Graceful stop shown in the existing error box. It must keep the phrase "no external evidence could be
// gathered": useWebBookEngine uses it to avoid rewriting messages that mention "quota"/"429" as a rate limit.
function buildNoLiveEvidenceMessage(
  query: string,
  mode: SearchFallbackMode,
  model: string,
  cause: GeminiSearchCause
): string {
  return [
    `Search stopped: ${describeFallbackProviders(mode)} returned no live results (selected Gemini model ${model}: ${GEMINI_SEARCH_CAUSE_PHRASES[cause]}), so no external evidence could be gathered for "${query}". No Web-book was generated.`,
    '',
    'What you can do next:',
    '• Search again with the same wording - search engines often recover within a minute.',
    '• Refine the wording - use fewer, more specific keywords, name the key people, places or terms, or drop time-sensitive phrasing.',
  ].join('\n');
}

async function performGeminiKnowledgeExtraction(
  query: string,
  selectedModel: string,
  geminiCause?: GeminiSearchCause
): Promise<SearchExtractionResult | null> {
  try {
    const knowledgeResponse = await generateWithModelFallback({
      contents: `Analyze the topic: "${query}". 
      Extract 5 distinct key analytical dimensions or thematic source perspectives on this topic.
      For each source perspective, provide:
      1. The title of the topic/perspective.
      2. A list of key definitions and terms.
      3. A list of salient sub-topics.
      4. A comprehensive summary of content (at least 200 words).
      5. Informative score (0.8-1.0).
      6. Authority score (0.8-1.0).`,
      config: {
        systemInstruction: "You are a master academic researcher. Output valid JSON only. Provide in-depth, rich, factual analysis, definitions, and sub-topics based on your comprehensive knowledge base.",
        responseMimeType: "application/json",
        maxOutputTokens: 4000,
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING },
              content: { type: Type.STRING },
              definitions: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    term: { type: Type.STRING },
                    description: { type: Type.STRING }
                  },
                  required: ["term", "description"]
                }
              },
              subTopics: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    title: { type: Type.STRING },
                    summary: { type: Type.STRING }
                  },
                  required: ["title", "summary"]
                }
              },
              informativeScore: { type: Type.NUMBER },
              authorityScore: { type: Type.NUMBER }
            },
            required: ["title", "content", "definitions", "subTopics", "informativeScore", "authorityScore"]
          }
        }
      }
    }, selectedModel);

    let kParsed: any[] = [];
    const kText = (knowledgeResponse?.text || '').trim();
    if (kText) {
      try {
        kParsed = JSON.parse(kText);
      } catch {
        kParsed = JSON.parse(repairTruncatedJSON(kText));
      }
    }

    if (Array.isArray(kParsed) && kParsed.length > 0) {
      const population: WebPageGenotype[] = kParsed.map((r: any, index: number) => ({
        id: `gen-${index}-${Date.now()}`,
        url: '',
        title: r.title || `Perspective ${index + 1}`,
        content: r.content ? r.content.substring(0, 2000) : '',
        definitions: (r.definitions || [])
          .filter((d: any) => isMeaningful(d.term, d.description))
          .map((d: any) => ({ ...d, sourceUrl: '' })),
        subTopics: (r.subTopics || [])
          .filter((s: any) => isMeaningful(s.title, s.summary))
          .map((s: any) => ({ ...s, sourceUrl: '' })),
        informativeScore: typeof r.informativeScore === 'number' ? r.informativeScore : 0.85,
        authorityScore: typeof r.authorityScore === 'number' ? r.authorityScore : 0.85,
        fitness: 0,
      }));

      const noteSuffix = geminiCause === 'quota_or_rate_limit'
        ? ' (external search grounding limit reached; synthesized via model intelligence)'
        : '';

      return {
        results: population,
        artifacts: {
          searchSummary: `Gemini synthesized ${population.length} deep analytical sources for "${query}".`,
        },
        generationNote: `Synthesized via Gemini knowledge synthesis model: ${selectedModel}${noteSuffix}; NOT verified against live web sources.`,
        sourceMode: 'model_knowledge',
      };
    }
  } catch (kErr) {
    console.warn("Gemini knowledge synthesis fallback encountered issue:", kErr);
  }
  return null;
}

export async function searchAndExtract(
  query: string,
  options: EngineOptions = { mode: 'google_duckduckgo', geminiModel: DEFAULT_GEMINI_MODEL }
): Promise<SearchExtractionResult> {
  const fallbackEnabled = options.mode !== 'off';
  const selectedModel = options.geminiModel || DEFAULT_GEMINI_MODEL;
  let geminiCause: GeminiSearchCause = 'no_content';

  try {
    const preferredModel = options.geminiModel || DEFAULT_GEMINI_MODEL;

    const response = await generateWithModelFallback({
      contents: `Search for comprehensive information about "${query}". 
      Identify at least 5 distinct high-quality web pages or sources from the search results. 
      For each source, extract:
      1. The exact, real URL verbatim from the search grounding results (never alter, truncate, or invent URLs).
      2. The title of the page.
      3. A list of key definitions found on the page.
      4. A list of salient sub-topics discussed.
      5. A summary of the content.
      6. An assessment of its "Informative Value" (0-1) based on depth of definitions.
      7. An assessment of its "Authority" (0-1) based on source credibility.`,
      config: {
        systemInstruction: "You are a precise data extractor. Extract only real, meaningful definitions and sub-topics from the search results. CRITICAL: For the 'url' property, use ONLY the exact, real URLs returned by Google Search grounding. Never invent, hallucinate, alter, or predict non-existent URLs. If no meaningful definitions are found for a source, return an empty array for that source's definitions.",
        tools: [{ googleSearch: {} }],
        responseMimeType: "application/json",
        maxOutputTokens: 4000,
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              url: { type: Type.STRING },
              title: { type: Type.STRING },
              content: { type: Type.STRING },
              definitions: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    term: { type: Type.STRING },
                    description: { type: Type.STRING }
                  },
                  required: ["term", "description"]
                }
              },
              subTopics: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    title: { type: Type.STRING },
                    summary: { type: Type.STRING }
                  },
                  required: ["title", "summary"]
                }
              },
              informativeScore: { type: Type.NUMBER },
              authorityScore: { type: Type.NUMBER }
            },
            required: ["url", "title", "content", "definitions", "subTopics", "informativeScore", "authorityScore"]
          }
        }
      }
    }, preferredModel);

    let parsed: any[] = [];
    const rawText = (response.text || "").trim();
    if (rawText) {
      try {
        parsed = JSON.parse(rawText);
      } catch {
        parsed = JSON.parse(repairTruncatedJSON(rawText));
      }
    }

    if (Array.isArray(parsed) && parsed.length > 0) {
      const verifiedGrounding = extractVerifiedGroundingSources(response);
      const population: WebPageGenotype[] = parsed.map((r: any, index: number) => {
        const resolved = resolveVerifiedSource(r, index, verifiedGrounding);
        const sourceUrl = resolved.url;
        const sourceTitle = resolved.title || r.title || `Source ${index + 1}`;

        return {
          id: `gen-${index}-${Date.now()}`,
          url: sourceUrl,
          title: sourceTitle,
          content: r.content ? r.content.substring(0, 2000) : "",
          definitions: (r.definitions || [])
            .filter((d: any) => isMeaningful(d.term, d.description))
            .map((d: any) => ({ ...d, sourceUrl })),
          subTopics: (r.subTopics || [])
            .filter((s: any) => isMeaningful(s.title, s.summary))
            .map((s: any) => ({ ...s, sourceUrl })),
          informativeScore: typeof r.informativeScore === 'number' ? r.informativeScore : 0.8,
          authorityScore: typeof r.authorityScore === 'number' ? r.authorityScore : 0.8,
          fitness: 0,
        };
      });

      const groundingChunks = (response.candidates?.[0]?.groundingMetadata?.groundingChunks || []).map((c: any) => ({
        web: {
          uri: c.web?.uri || c.uri || '',
          title: c.web?.title || c.title || '',
        }
      }));

      return {
        results: population,
        artifacts: {
          groundingChunks,
          searchSummary: `Gemini extracted ${population.length} grounded sources for "${query}".`,
        },
        generationNote: `Evidence gathered via Google Search grounding by the selected Gemini model: ${selectedModel}.`,
        sourceMode: 'gemini',
      };
    }

    if (!fallbackEnabled) {
      const knowledgeResult = await performGeminiKnowledgeExtraction(query, selectedModel, 'no_content');
      if (knowledgeResult) {
        return knowledgeResult;
      }
      throw new Error(`Gemini-only search returned no usable sources for "${query}".`);
    }
  } catch (geminiError: any) {
    if (geminiError instanceof SyntaxError) {
      try {
        // Step 1: Grounded research call without responseMimeType
        const researchResponse = await generateWithModelFallback({
          contents: `Search for comprehensive information about "${query}". Provide thorough research notes based on the web results.`,
          config: {
            systemInstruction: "You are a research assistant. Conduct web searches and return detailed factual information.",
            tools: [{ googleSearch: {} }],
            maxOutputTokens: 4000,
          }
        }, selectedModel);

        const researchText = String(researchResponse?.text || '').trim();
        const researchGrounding = extractVerifiedGroundingSources(researchResponse);

        if (researchText && researchGrounding.length > 0) {
          // Step 2: Structuring call without search tools
          const structResponse = await generateWithModelFallback({
            contents: `Extract sources, definitions, and sub-topics from these research notes:\n\n${researchText}`,
            config: {
              systemInstruction: "Extract structured data from the research notes. Output valid JSON array.",
              responseMimeType: "application/json",
              maxOutputTokens: 4000,
              responseSchema: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    url: { type: Type.STRING },
                    title: { type: Type.STRING },
                    content: { type: Type.STRING },
                    definitions: {
                      type: Type.ARRAY,
                      items: {
                        type: Type.OBJECT,
                        properties: {
                          term: { type: Type.STRING },
                          description: { type: Type.STRING }
                        },
                        required: ["term", "description"]
                      }
                    },
                    subTopics: {
                      type: Type.ARRAY,
                      items: {
                        type: Type.OBJECT,
                        properties: {
                          title: { type: Type.STRING },
                          summary: { type: Type.STRING }
                        },
                        required: ["title", "summary"]
                      }
                    },
                    informativeScore: { type: Type.NUMBER },
                    authorityScore: { type: Type.NUMBER }
                  },
                  required: ["url", "title", "content", "definitions", "subTopics", "informativeScore", "authorityScore"]
                }
              }
            }
          }, selectedModel);

          let structParsed: any[] = [];
          const structRaw = (structResponse?.text || "").trim();
          if (structRaw) {
            try {
              structParsed = JSON.parse(structRaw);
            } catch {
              structParsed = JSON.parse(repairTruncatedJSON(structRaw));
            }
          }

          if (Array.isArray(structParsed) && structParsed.length > 0) {
            const population: WebPageGenotype[] = structParsed.map((r: any, index: number) => {
              const resolved = resolveVerifiedSource(r, index, researchGrounding);
              const sourceUrl = resolved.url;
              return {
                id: `gen-${index}-${Date.now()}`,
                url: sourceUrl,
                title: resolved.title || r.title || `Source ${index + 1}`,
                content: r.content ? r.content.substring(0, 2000) : "",
                definitions: (r.definitions || []).filter((d: any) => isMeaningful(d.term, d.description)).map((d: any) => ({ ...d, sourceUrl })),
                subTopics: (r.subTopics || []).filter((s: any) => isMeaningful(s.title, s.summary)).map((s: any) => ({ ...s, sourceUrl })),
                informativeScore: typeof r.informativeScore === 'number' ? r.informativeScore : 0.8,
                authorityScore: typeof r.authorityScore === 'number' ? r.authorityScore : 0.8,
                fitness: 0,
              };
            });

            return {
              results: population,
              artifacts: {
                groundingChunks: (researchResponse.candidates?.[0]?.groundingMetadata?.groundingChunks || []).map((c: any) => ({
                  web: { uri: c.web?.uri || c.uri || '', title: c.web?.title || c.title || '' }
                })),
                searchSummary: `Gemini extracted ${population.length} grounded sources for "${query}".`,
              },
              generationNote: `Evidence gathered via Google Search grounding by the selected Gemini model: ${selectedModel}.`,
              sourceMode: 'gemini',
            };
          }
        }
      } catch (twoStepErr) {
        console.warn("Two-step search recovery encountered issue:", twoStepErr);
      }
    }

    console.warn("Gemini search failed or unavailable, checking fallback...", geminiError);
    geminiCause = classifyGeminiSearchFailure(geminiError);

    if (!fallbackEnabled) {
      const reason = detectGeminiFailureReason(geminiError);
      if (NON_RECOVERABLE_GEMINI_REASONS.has(reason)) {
        throw new Error(buildGeminiUserFacingErrorMessage(geminiError, reason));
      }
      const knowledgeResult = await performGeminiKnowledgeExtraction(query, selectedModel, geminiCause);
      if (knowledgeResult) {
        return knowledgeResult;
      }

      if (geminiCause === 'model_unavailable') {
        throw new Error(`Selected Gemini model: ${selectedModel} is not available. Choose another model and try again.`);
      }
      throw new Error(buildGeminiUserFacingErrorMessage(geminiError, reason));
    }
  }

  // Fallback search execution
  let fallbackPayload: SearchFallbackPayload | null = null;
  try {
    fallbackPayload = await fetchGoogleSearchFallback(query, options);
  } catch (fallbackError) {
    console.warn("Fallback search execution failed:", fallbackError);
  }

  // A synthetic payload is a placeholder the server fabricates when Google and DuckDuckGo both return nothing.
  // When live search returns 0 results or synthetic fallback, seamlessly synthesize from Gemini knowledge base
  // rather than stopping the run with an error.
  if (
    !fallbackPayload
    || !Array.isArray(fallbackPayload.results)
    || fallbackPayload.results.length === 0
    || isSyntheticFallbackPayload(fallbackPayload)
  ) {
    const knowledgeResult = await performGeminiKnowledgeExtraction(query, selectedModel, geminiCause);
    if (knowledgeResult) {
      return knowledgeResult;
    }

    throw new Error(buildNoLiveEvidenceMessage(query, options.mode, selectedModel, geminiCause));
  }

  const fallbackEvidence = describeFallbackEvidence(fallbackPayload, options.mode);

  const fallbackPopulation: WebPageGenotype[] = fallbackPayload.results.map((res, index) => {
    const rawContent = [res.snippet, res.excerpt].filter(Boolean).join(' ');
    // Strip URL artifacts first and split on sentence boundaries: splitting on every "." also cut URLs, decimals and
    // abbreviations into fragments that were then shown as definitions. Interface text that came along with the page
    // ("13,677 followers", "Cite this / Export Record ...") is not something the source says and is dropped here.
    const readable = splitIntoSentences(sanitizeNarrativeText(rawContent)).filter(sentence => !isPageChromeText(sentence));
    const sentences = readable.filter(s => s.length > 20);

    return {
      id: `fallback-${index}-${Date.now()}`,
      url: res.url,
      title: res.title,
      content: readable.length > 0 ? joinSentences(readable) : (rawContent || res.title),
      definitions: extractDefinitionsFromSentences(sentences, res.url),
      // Search snippets have no sub-topic structure; restating their sentences under "Key Area N" titles only duplicated them.
      subTopics: [],
      informativeScore: 0.85,
      authorityScore: 0.9,
      fitness: 0,
    };
  });

  return {
    results: fallbackPopulation,
    artifacts: {
      groundingChunks: fallbackPayload.results.map(r => ({ web: { uri: r.url, title: r.title } })),
      searchSummary: fallbackPayload.summary || `Live fallback search retrieved ${fallbackPayload.results.length} sources via ${fallbackPayload.provider}.`,
    },
    generationNote: `Selected Gemini model: ${selectedModel} unavailable (${GEMINI_SEARCH_CAUSE_PHRASES[geminiCause]}); gathered evidence via ${fallbackEvidence.label}.`,
    sourceMode: 'fallback_search',
    fallbackSource: fallbackEvidence.source,
    fallbackReason: GEMINI_SEARCH_CAUSE_TO_FALLBACK_REASON[geminiCause],
  };
}

const MAX_DEFINITIONS_PER_PAGE = 3;
// "term: description", "X is defined as / refers to / represents Y", Malay "X ialah / adalah / merupakan Y", Chinese "X是 / 指 / 乃 Y".
const DEFINITION_PATTERNS: RegExp[] = [
  /^([^:\n]{3,40}):\s+(.+)$/,
  /^([A-Z][a-zA-Z0-9\s\-]{2,35})\s+(?:is defined as|refers to|represents|is a|is an)\s+(.+)$/i,
  /^([A-Z][\p{L}0-9\s\-]{2,45}?)\s+(?:ialah|adalah|merupakan|ditakrifkan sebagai)\s+(.+)$/iu,
  /^([\u3400-\u9fff][\u3400-\u9fffA-Za-z0-9·（）() ]{1,18}?)(?:是|指的是|即|乃|为)([\u3400-\u9fff].{9,})$/u,
];

// "这不仅是…", "本期文章将为…", "马来西亚的石油储存并不是…": splitting a sentence at its first 是 / 为 yields a clause opening, not a term.
const CJK_CLAUSE_START = /^(?:这|那|其|它|他|她|我|你|您|该|此|本期|本文|本篇|本次|因此|所以|但|而|并|同时|此外|如果|由于|虽然)/;
// Only tails that never end a noun: 会 / 才 / 就 / 都 / 能 / 应 are left out because 学会, 人才, 成就, 首都, 功能, 供应 are terms.
const CJK_CLAUSE_END = /(?:不|仅|将|并|当时|同时|已|曾|主要|最|很|非常|也|还)$/;
// Verbal particles only count inside a longer term, where a clause is likelier than a word such as 了解 or 将军.
const CJK_CLAUSE_PARTICLE = /[了将被把]/;

export function isPlausibleChineseTerm(term: string): boolean {
  const length = term.replace(/\s/g, '').length;
  return length >= 2 && length <= 12 && !CJK_CLAUSE_START.test(term) && !CJK_CLAUSE_END.test(term) && !(length >= 6 && CJK_CLAUSE_PARTICLE.test(term));
}

export function extractDefinitionsFromSentences(sentences: string[], sourceUrl: string, max = MAX_DEFINITIONS_PER_PAGE): Definition[] {
  const definitions: Definition[] = [];
  for (const sentence of sentences) {
    if (definitions.length >= max) break;
    for (const pattern of DEFINITION_PATTERNS) {
      const match = sentence.match(pattern);
      if (!match) continue;
      const term = match[1].trim();
      const description = match[2].trim();
      if (pattern === DEFINITION_PATTERNS[3] && !isPlausibleChineseTerm(term)) continue;
      if (
        isValidConceptDefinition(term, description)
        && isMeaningful(term, description)
        && !definitions.some(existing => existing.term.toLowerCase() === term.toLowerCase())
      ) {
        definitions.push({ term, description, sourceUrl });
        break;
      }
    }
  }
  return definitions;
}

export function calculateFitness(
  page: WebPageGenotype,
  optimalSet: WebPageGenotype[],
  weights: { alpha: number; beta: number; gamma: number }
): number {
  const { alpha, beta, gamma } = weights;

  let redundancy = 0;
  if (optimalSet.length > 0) {
    const currentTerms = new Set(optimalSet.flatMap(p => (p.definitions || []).map(d => (d.term || "").toLowerCase())));
    const pageTerms = (page.definitions || []).map(d => (d.term || "").toLowerCase());
    const overlap = pageTerms.filter(t => t && currentTerms.has(t)).length;
    redundancy = overlap / Math.max(pageTerms.length, 1);
  }

  return (alpha * page.informativeScore) + (beta * page.authorityScore) - (gamma * redundancy);
}

export async function evolve(
  population: WebPageGenotype[],
  generations: number = 3
): Promise<{ population: WebPageGenotype[]; completedGenerations: number; bestRedundancyPenalty: number }> {
  const weights = { alpha: 0.5, beta: 0.3, gamma: 0.2 };

  // 1. Remove verbatim duplicate pages
  const uniquePopulation: WebPageGenotype[] = [];
  for (const page of population) {
    const isDuplicate = uniquePopulation.some(
      (kept) => calculateTextSimilarity(kept.content, page.content) >= 0.9
    );
    if (!isDuplicate) {
      uniquePopulation.push({ ...page });
    }
  }

  // 2. Select and rank original pages iteratively using calculateFitness with optimalSet
  const remaining = [...uniquePopulation];
  const selectedOriginals: WebPageGenotype[] = [];

  while (remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      const fitness = calculateFitness(candidate, selectedOriginals, weights);
      candidate.fitness = fitness;
      if (fitness > bestScore) {
        bestScore = fitness;
        bestIndex = i;
      }
    }

    selectedOriginals.push(remaining[bestIndex]);
    remaining.splice(bestIndex, 1);
  }

  // Keep original pages (at least 6 if available, up to ASSEMBLY_SOURCE_POOL_SIZE or unique size)
  const targetOriginalsCount = Math.max(
    Math.min(MIN_EVOLVED_SOURCES, uniquePopulation.length),
    Math.min(selectedOriginals.length, ASSEMBLY_SOURCE_POOL_SIZE)
  );
  const keptOriginals = selectedOriginals.slice(0, targetOriginalsCount);

  // 3. Create offspring from top survivors if recombining
  const offspring: WebPageGenotype[] = [];
  if (keptOriginals.length >= 2) {
    for (let i = 0; i < keptOriginals.length - 1; i += 2) {
      const parentA = keptOriginals[i];
      const parentB = keptOriginals[i + 1];
      offspring.push({
        id: `offspring-0-${i}`,
        url: parentA.url || parentB.url,
        title: `Synthesized: ${parentA.title} & ${parentB.title}`,
        content: `${parentA.content.substring(0, 500)}... ${parentB.content.substring(0, 500)}...`,
        definitions: [
          ...(parentA.definitions || []).slice(0, Math.ceil((parentA.definitions?.length || 0) / 2)),
          ...(parentB.definitions || []).slice(Math.ceil((parentB.definitions?.length || 0) / 2))
        ],
        subTopics: [
          ...(parentA.subTopics || []).slice(0, Math.ceil((parentA.subTopics?.length || 0) / 2)),
          ...(parentB.subTopics || []).slice(Math.ceil((parentB.subTopics?.length || 0) / 2))
        ],
        informativeScore: (parentA.informativeScore + parentB.informativeScore) / 2,
        authorityScore: (parentA.authorityScore + parentB.authorityScore) / 2,
        fitness: 0
      });
    }
  }

  const finalPopulation = [...keptOriginals, ...offspring];

  let bestRedundancyPenalty = 0;
  if (keptOriginals.length > 1) {
    const terms = keptOriginals.map(p => (p.definitions || []).map(d => d.term.toLowerCase()));
    let overlapCount = 0;
    for (let i = 0; i < terms.length; i++) {
      for (let j = i + 1; j < terms.length; j++) {
        overlapCount += terms[i].filter(t => terms[j].includes(t)).length;
      }
    }
    bestRedundancyPenalty = Math.min(1, overlapCount / Math.max(1, keptOriginals.length * 4));
  }

  return {
    population: finalPopulation,
    completedGenerations: generations,
    bestRedundancyPenalty,
  };
}

const FALLBACK_MAX_CHAPTERS = 6;
const CHAPTER_TITLE_MAX_CHARS = 80;
// Titles that name a website or a page type, not what the page is about.
const GENERIC_TITLE_PATTERN = /^(?:home(?:page)?|index|untitled|welcome|main page|about(?: us)?|contact(?: us)?|login|sign in|facebook|instagram|twitter|youtube|scribd|wikipedia|search results?|page \d+|overview|introduction|menu|navigation|sitemap|gallery|downloads?|news|events?|焦点|文告|专题|头条|要闻|评论|社论|特写|专栏|访谈|focus|opinion|editorial|无标题|首页|主页|欢迎|联系我们|联络我们|聯繫我們|联系方式|关于我们|關於我們|关于|简介|概述|新闻|最新消息|活动|hubungi kami|tentang kami|laman utama|utama)$/i;
const TITLE_SEPARATOR = /\s+(?:[-|–—·•:]{1,2}|::)\s+|\s*[|｜]\s*/;

function normalizeTitleKey(title: string): string {
  return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** The page's own heading without the site name, counters or truncation marks ("Foo - Wikipedia" -> "Foo"). */
export function cleanSourceTitle(rawTitle: string, url = ''): string {
  const host = (() => { try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } })();
  const hostLabel = host.split('.')[0] || '';
  const segments = sanitizeNarrativeText(rawTitle)
    .replace(/\s+/g, ' ')
    .replace(CHAPTER_NUMBER_PREFIX, '')
    .replace(/^\s*[\[(【]?\s*(?:PDF|DOCX?|PPTX?|XLSX?)\s*[\])】]?[:：-]?\s+/i, '')
    .replace(/\s*(?:\.{3}|…)\s*$/, '')
    .split(TITLE_SEPARATOR)
    .map(segment => segment.trim())
    .filter(Boolean);
  const isSiteName = (segment: string) => {
    const key = normalizeTitleKey(segment).replace(/ /g, '');
    return GENERIC_TITLE_PATTERN.test(segment.trim()) || (hostLabel.length > 2 && (key === hostLabel || key === host.replace(/\./g, '')));
  };
  const candidates = segments.filter(segment => !isSiteName(segment) && /[\p{L}\p{N}]/u.test(segment));
  const first = candidates[0] || '';
  const longest = candidates.reduce((best, segment) => (segment.length > best.length ? segment : best), '');
  // "文告 | <headline>": a short section label in front of the real headline is not the title.
  const shortLimit = /[\u3400-\u9fff]/.test(first) ? 6 : 14;
  const chosen = first && first.length < shortLimit && longest.length >= first.length * 2 ? longest : first;
  if (!chosen || /^[a-z0-9_-]+\.[a-z]{2,}$/i.test(chosen)) return '';
  return clipLabelAtWordBoundary(chosen, CHAPTER_TITLE_MAX_CHARS).replace(/[\s,;:，；：、-]+$/, '').trim();
}

// Sentence-opening connectives that make a clipped sentence read as the middle of a thought.
const LEADING_CONNECTIVE = /^(?:与此同时|同时|此外|另外|此後|此后|然而|但是|不过|可是|于是|接着|其次|最后|并且|但|而|因此|所以|而且|另一方面|however|meanwhile|moreover|furthermore|in addition|additionally|also|and|but|so|dengan itu|selain itu|manakala|namun)\s*[,，、]?\s*/i;

/** A chapter's own first sentence as a heading: connective dropped, cut at the first clause, short. */
export function leadSentenceTitle(sentence: string): string {
  // A leading "（来源：…）" / "[1]" group is a citation, not the subject of the sentence.
  const text = sentence.replace(/[\s.。!?！？]+$/, '').replace(/^\s*[（(\[【][^）)\]】]{0,80}[）)\]】]\s*/, '').replace(LEADING_CONNECTIVE, '').trim();
  const cjk = /[\u3400-\u9fff]/.test(text);
  const minClause = cjk ? 8 : 20;
  const clause = text.split(/[,;，；、:：]/)[0].trim();
  const base = clause.length >= minClause ? clause : text;
  return clipLabelAtWordBoundary(base, cjk ? 24 : 60).replace(/…$/, '').replace(/[\s,;:，；：、-]+$/, '').trim();
}

/**
 * Chapter titles come from the evidence: the page most of the chapter's sentences were taken from supplies the heading,
 * then the next source in the chapter, and finally the chapter's own first sentence. A title is never repeated and never
 * just the book's topic, so the table of contents tells the sources apart.
 */
export function deriveChapterTitle(
  units: Array<{ text: string; url: string }>,
  titleByUrl: Map<string, string>,
  topic: string,
  usedTitles: Set<string>,
  index: number
): string {
  const counts = new Map<string, number>();
  units.forEach(unit => counts.set(unit.url, (counts.get(unit.url) || 0) + 1));
  const ranked = [...counts.entries()].sort((x, y) => y[1] - x[1]).map(([url]) => url);
  const topicKey = normalizeTitleKey(topic);
  const acceptable = (title: string) => {
    const key = normalizeTitleKey(title);
    return Boolean(key) && !usedTitles.has(key) && key !== topicKey && calculateTextSimilarity(key, topicKey) < 0.9;
  };

  for (const url of ranked) {
    const title = cleanSourceTitle(titleByUrl.get(url) || '', url);
    if (title && acceptable(title)) return title;
  }

  // A source titled exactly like the book ("<Topic> - Wikipedia") is told apart by where it comes from.
  for (const url of ranked) {
    const title = cleanSourceTitle(titleByUrl.get(url) || '', url);
    const host = (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } })();
    const qualified = title && host ? `${title} (${host})` : '';
    if (qualified && title && normalizeTitleKey(title) === topicKey && !usedTitles.has(normalizeTitleKey(qualified))) return qualified;
  }

  const lead = leadSentenceTitle(units[0].text);
  if (lead && acceptable(lead)) return lead;
  return `${clipLabelAtWordBoundary(topic, 60)} · ${index + 1}`;
}

/**
 * Chapter boundaries (start indices plus the end) over evidence sentences: as even as possible, moved to the nearest point
 * where the source changes (within a third of a chapter) so a source is not split across chapters needlessly, and never
 * leaving a chapter with fewer than FALLBACK_MIN_SENTENCES_PER_CHAPTER sentences.
 */
export function chooseChapterCuts(urls: string[], chapterCount: number): number[] {
  const total = urls.length;
  const minSize = Math.min(FALLBACK_MIN_SENTENCES_PER_CHAPTER, Math.max(1, Math.floor(total / chapterCount)));
  const slack = Math.floor(total / chapterCount / 3);
  const cuts = [0];
  for (let k = 1; k < chapterCount; k += 1) {
    const ideal = Math.round((k * total) / chapterCount);
    let best = ideal;
    for (let d = 0; d <= slack; d += 1) {
      const hit = [ideal - d, ideal + d].find(i => i > 0 && i < total && urls[i] !== urls[i - 1]);
      if (hit !== undefined) { best = hit; break; }
    }
    const lo = cuts[cuts.length - 1] + minSize;
    const hi = total - minSize * (chapterCount - k);
    cuts.push(Math.max(lo, Math.min(best, hi)));
  }
  cuts.push(total);
  return cuts;
}

// Least evidence a chapter of an offline book is written from. Fewer, fuller chapters beat many thin ones: below this a
// "chapter" is a heading with a caption, not something with real reading substance.
const FALLBACK_MIN_SENTENCES_PER_CHAPTER = 4;
const FALLBACK_MIN_WORDS_PER_CHAPTER = 80;
const FALLBACK_MAX_SENTENCES_PER_PARAGRAPH = 5;
// Text from social / forum / storefront hosts is evidence of last resort: it is only used while the reliable sources
// together have fewer distinct sentences than this.
const FALLBACK_MIN_RELIABLE_SENTENCES = 12;

type FallbackEvidenceUnit = { text: string; url: string; tier: ReturnType<typeof classifySourceReliability> };

/** Source paragraphs stay together: runs of one source's sentences, at most a few long, with stray one-liners folded in. */
function buildChapterParagraphs(units: FallbackEvidenceUnit[]): string[] {
  const runs: Array<{ url: string; sentences: string[] }> = [];
  units.forEach(unit => {
    const last = runs[runs.length - 1];
    if (last && last.url === unit.url && last.sentences.length < FALLBACK_MAX_SENTENCES_PER_PARAGRAPH) {
      last.sentences.push(unit.text);
    } else {
      runs.push({ url: unit.url, sentences: [unit.text] });
    }
  });

  const merged: Array<{ url: string; sentences: string[] }> = [];
  runs.forEach(run => {
    if (run.sentences.length < 2 && merged.length > 0) {
      merged[merged.length - 1].sentences.push(...run.sentences);
    } else {
      merged.push(run);
    }
  });
  if (merged.length > 1 && merged[0].sentences.length < 2) {
    merged[1].sentences.unshift(...merged[0].sentences);
    merged.shift();
  }
  return merged.map(run => joinSentences(run.sentences));
}

export function synthesizeFallbackWebBook(
  topic: string,
  sources: WebPageGenotype[],
  searchResult?: any
): WebBook {
  // Evolution keeps only half of the gathered pages per generation, which leaves too little distinct evidence for six
  // chapters. The pages it pruned are therefore used after the survivors; offspring add nothing of their own and are skipped.
  const seenPages = new Set<string>();
  const pool: WebPageGenotype[] = [...sources, ...(searchResult?.results || [])].filter((page: WebPageGenotype) => {
    const key = page?.id || page?.url;
    if (!key || key.startsWith(OFFSPRING_ID_PREFIX) || seenPages.has(key)) return false;
    seenPages.add(key);
    return true;
  });

  const validSources = pool
    .filter(s => s.url && /^https?:\/\//i.test(s.url) && !s.url.includes('source-') && !s.url.includes('knowledge-base.org'))
    .map(s => ({ title: s.title, url: s.url }))
    .filter((source, index, all) => all.findIndex(other => other.url === source.url) === index);

  // Every distinct sentence of gathered evidence is used once across the whole book. The most reliable sources lead (the
  // sort is stable, so search order still decides within a reliability tier), and when two sources say the same thing
  // the more reliable one is the one that is kept.
  const tierRank = { high: 0, medium: 1, low: 2 } as const;
  const rankedPool = pool
    .map((page, order) => ({ page, order, tier: classifySourceReliability(page.url) }))
    .sort((a, b) => tierRank[a.tier] - tierRank[b.tier] || a.order - b.order);

  const gatheredEvidence: FallbackEvidenceUnit[] = [];
  rankedPool.forEach(({ page, tier }) => {
    splitIntoSentences(normalizeCjkSpacing(stripSnippetSplices(sanitizeNarrativeText(page.content)))).forEach(text => {
      if (isPageChromeText(text)) return;
      if (!gatheredEvidence.some(kept => calculateTextSimilarity(kept.text, text) >= 0.88)) {
        gatheredEvidence.push({ text, url: page.url, tier });
      }
    });
  });
  const reliableEvidence = gatheredEvidence.filter(unit => unit.tier !== 'low');
  const evidence = reliableEvidence.length >= FALLBACK_MIN_RELIABLE_SENTENCES ? reliableEvidence : gatheredEvidence;
  const droppedLowReliability = gatheredEvidence.length - evidence.length;

  // Definitions and sub-topics go to the chapter that uses their own source, and each is placed once.
  const unplacedDefinitions = new Set(getRenderableDefinitions(pool.flatMap(page => page.definitions || [])));
  const unplacedSubTopics = new Set(getRenderableSubTopics(pool.flatMap(page => page.subTopics || [])));
  const claimFor = <T extends { sourceUrl?: string }>(unplaced: Set<T>, urls: Set<string>, limit: number): T[] => {
    const claimed = [...unplaced].filter(item => item.sourceUrl && urls.has(item.sourceUrl)).slice(0, limit);
    claimed.forEach(item => unplaced.delete(item));
    return claimed;
  };

  // Chapter count follows the amount of evidence: six chapters made of one sentence each only look like a book.
  const evidenceWords = evidence.reduce((sum, unit) => sum + countWords(unit.text), 0);
  const chapterCount = Math.max(1, Math.min(
    FALLBACK_MAX_CHAPTERS,
    Math.floor(evidence.length / FALLBACK_MIN_SENTENCES_PER_CHAPTER),
    Math.floor(evidenceWords / FALLBACK_MIN_WORDS_PER_CHAPTER)
  ));
  const cuts = chooseChapterCuts(evidence.map(unit => unit.url), chapterCount);
  const titleByUrl = new Map<string, string>();
  pool.forEach(page => { if (page.url && !titleByUrl.has(page.url)) titleByUrl.set(page.url, page.title); });
  const usedTitles = new Set<string>();

  const chapters: Chapter[] = [];
  // Chapters follow the sources: a cut lands where one source ends and the next begins whenever that is close to an even
  // split. Cuts are by sentence count, so a chapter of short sentences can still come out thin: such a chapter is folded
  // into its shorter neighbour until every chapter has real reading substance (or only one chapter is left).
  const groupWords = (group: FallbackEvidenceUnit[]) => group.reduce((sum, unit) => sum + countWords(unit.text), 0);
  // Long sentences (Chinese especially) can reach the word floor in three sentences, so both floors apply.
  const isThin = (group: FallbackEvidenceUnit[]) => groupWords(group) < FALLBACK_MIN_WORDS_PER_CHAPTER || group.length < FALLBACK_MIN_SENTENCES_PER_CHAPTER;
  const groups: FallbackEvidenceUnit[][] = cuts.slice(0, -1).map((start, idx) => evidence.slice(start, cuts[idx + 1])).filter(group => group.length > 0);
  for (;;) {
    const thinIndex = groups.findIndex(isThin);
    if (thinIndex < 0 || groups.length <= 1) break;
    const neighbours = [thinIndex - 1, thinIndex + 1].filter(i => i >= 0 && i < groups.length);
    const into = neighbours.reduce((best, i) => (groupWords(groups[i]) < groupWords(groups[best]) ? i : best), neighbours[0]);
    const [first, second] = into < thinIndex ? [into, thinIndex] : [thinIndex, into];
    groups.splice(first, 2, [...groups[first], ...groups[second]]);
  }

  groups.forEach((units, idx) => {
    // With no evidence a chapter is left out rather than padded with generic wording.
    if (units.length === 0) return;

    const title = deriveChapterTitle(units, titleByUrl, topic, usedTitles, idx);
    usedTitles.add(normalizeTitleKey(title));

    const narrative = buildChapterParagraphs(units).join('\n\n');

    const unitUrls = new Set(units.map(unit => unit.url));
    const chapterSources = validSources.filter(source => unitUrls.has(source.url));

    chapters.push({
      title,
      content: narrative,
      definitions: claimFor(unplacedDefinitions, unitUrls, 3),
      subTopics: claimFor(unplacedSubTopics, unitUrls, 2),
      sourceUrls: chapterSources.length > 0 ? chapterSources : validSources.slice(0, 3),
      visualSeed: `${topic} ${title}`,
    });
  });

  // Same stance as searchAndExtract: never present generic filler as researched evidence.
  if (chapters.length === 0) {
    throw new Error(`Search stopped: the gathered sources for "${topic}" contained no readable text (only titles and links), so the Web-book could not be written. Search again, or refine the wording.`);
  }

  return {
    id: `book-${Date.now()}`,
    topic,
    timestamp: Date.now(),
    chapters,
    sourceMode: searchResult?.sourceMode || 'fallback_search',
    generationNote: [
      searchResult?.generationNote || 'Synthesized via resilient multi-source evolutionary engine.',
      `Compiled offline from ${new Set(evidence.map(unit => unit.url)).size} sources (${evidence.length} sentences, ${evidenceWords} words)` +
        `${droppedLowReliability > 0 ? `; ${droppedLowReliability} sentences from low-reliability sites were left out` : ''}.`,
    ].join(' '),
    fallbackSource: searchResult?.fallbackSource,
    fallbackReason: searchResult?.fallbackReason,
  };
}

// Evolved pages that carry evidence of their own, best first; offspring only fill remaining slots.
function selectAssemblyPages(population: WebPageGenotype[]): WebPageGenotype[] {
  const originals = population.filter((page) => !page.id.startsWith(OFFSPRING_ID_PREFIX));
  const children = population.filter((page) => page.id.startsWith(OFFSPRING_ID_PREFIX));
  return (originals.length > 0 ? [...originals, ...children] : population).slice(0, ASSEMBLY_SOURCE_POOL_SIZE);
}

// The research the model is asked to write from. Stage 2 used to receive only the chapter title and focus, so the
// "chapters" were generic model text with sources attached afterwards.
export function buildEvidenceDigest(pages: WebPageGenotype[]): string {
  const blocks: string[] = [];
  let used = 0;
  pages.forEach((page, index) => {
    const definitions = (page.definitions || []).slice(0, 6).map((d) => `${d.term}: ${d.description}`).join(' | ');
    const subTopics = (page.subTopics || []).slice(0, 4).map((t) => `${t.title}: ${t.summary}`).join(' | ');
    const block = [
      `[Source ${index + 1}] ${page.title}${page.url ? ` (${page.url})` : ''}`,
      (page.content || '').substring(0, EVIDENCE_CHARS_PER_SOURCE),
      definitions ? `Definitions: ${definitions}` : '',
      subTopics ? `Sub-topics: ${subTopics}` : '',
    ].filter(Boolean).join('\n');

    const separator = blocks.length > 0 ? 2 : 0; // the "\n\n" between blocks counts against the budget too
    const room = EVIDENCE_TOTAL_CHAR_BUDGET - used - separator;
    if (room <= 200) return;
    const clipped = block.substring(0, room);
    blocks.push(clipped);
    used += clipped.length + separator;
  });
  return blocks.join('\n\n');
}

type BoundedResult<T> = { status: 'ok'; value: T } | { status: 'failed'; error: unknown } | { status: 'skipped' };

// Runs `count` jobs with at most `limit` in flight, never rejecting: a failed job is recorded and the others carry on.
// When `isFatal` says a failure cannot be fixed by retrying (bad key, daily quota used up, ...), jobs not yet started are
// skipped instead of burning more requests on a book that cannot be finished.
async function runBounded<T>(
  count: number,
  limit: number,
  worker: (index: number) => Promise<T>,
  isFatal: (error: unknown) => boolean
): Promise<Array<BoundedResult<T>>> {
  const results: Array<BoundedResult<T>> = Array.from({ length: count }, () => ({ status: 'skipped' as const }));
  let nextIndex = 0;
  let stopped = false;

  const lane = async () => {
    while (!stopped) {
      const index = nextIndex++;
      if (index >= count) return;
      try {
        results[index] = { status: 'ok', value: await worker(index) };
      } catch (error) {
        results[index] = { status: 'failed', error };
        if (isFatal(error)) stopped = true;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, count)) }, lane));
  return results;
}

function parseJsonObject(text: string | undefined): any {
  const raw = String(text || '');
  try {
    return JSON.parse(raw);
  } catch {
    return JSON.parse(repairTruncatedJSON(raw));
  }
}

// ---------------------------------------------------------------------------
// References for books written from the model's own knowledge
// ---------------------------------------------------------------------------
// When neither grounded search nor the fallback search returns evidence, the book is synthesized from Gemini's knowledge
// (sourceMode "model_knowledge"). Its pages carry no URL, so the chapters used to end up with no references at all. The
// text is not changed, but each chapter now gets links the reader can follow: live search results for the chapter's
// subject when a search is reachable, otherwise plain search links. Neither kind is presented as a source of the text.

export const KNOWLEDGE_REFERENCES_PER_CHAPTER = 3;
const KNOWLEDGE_REFERENCE_LOOKUP_TIMEOUT_MS = 15_000;
const KNOWLEDGE_REFERENCE_CONCURRENCY = 3;
const REFERENCE_QUERY_TOPIC_UNITS = 90;
const CJK_ANY = /[ᄀ-ᇿ⺀-꓏가-힯豈-﫿＀-￯]/;

type ReferenceLookup = (query: string, options: EngineOptions) => Promise<SearchFallbackPayload>;

function isSearchEnginePage(url: URL): boolean {
  const host = url.hostname.replace(/^www\./i, '').toLowerCase();
  return (
    ((host === 'google.com' || host.endsWith('.google.com')) && url.pathname === '/search') ||
    host === 'duckduckgo.com'
  );
}

// Model-written chapter titles often start with their own numbering ("Chapter 3:", "第三章：", "3."); it is noise in a search.
function buildReferenceQuery(topic: string, chapterTitle: string): string {
  const title = String(chapterTitle || '').replace(CHAPTER_NUMBER_PREFIX, '').replace(/\s+/g, ' ').trim();
  const shortTopic = summarizeTitle(topic, REFERENCE_QUERY_TOPIC_UNITS).replace(/…$/, '').trim();
  if (!title) return shortTopic;
  // A descriptive title is a better search than the same title buried in a clipped topic; a generic one ("Future Outlook")
  // needs the topic to mean anything.
  const specific = CJK_ANY.test(title) ? [...title].length >= 8 : title.split(/\s+/).length >= 4;
  if (specific || !shortTopic || title.toLowerCase().includes(shortTopic.toLowerCase())) return title;
  return `${shortTopic} ${title}`.trim();
}

/** Plain search links for a chapter. They search for the subject; they do not point at a page that supports the text. */
export function buildReferenceSearchLinks(topic: string, chapterTitle: string): Array<{ title: string; url: string }> {
  const query = buildReferenceQuery(topic, chapterTitle);
  if (!query) return [];
  const wikipediaHost = CJK_ANY.test(query) ? 'zh.wikipedia.org' : 'en.wikipedia.org';
  const encoded = encodeURIComponent(query);
  return [
    { title: `Wikipedia search: ${query}`, url: `https://${wikipediaHost}/w/index.php?search=${encoded}` },
    { title: `Google Scholar search: ${query}`, url: `https://scholar.google.com/scholar?q=${encoded}` },
  ];
}

function pickReferenceResults(payload: SearchFallbackPayload | null | undefined, used: Set<string>): Array<{ title: string; url: string }> {
  if (!payload || isSyntheticFallbackPayload(payload) || !Array.isArray(payload.results)) return [];
  const picked: Array<{ title: string; url: string }> = [];
  for (const result of payload.results) {
    const rawUrl = String(result?.url || '').trim();
    if (!/^https?:\/\//i.test(rawUrl)) continue;
    try {
      const parsed = new URL(rawUrl);
      if (isSearchEnginePage(parsed) || parsed.hostname.includes('source-') || parsed.hostname === 'knowledge-base.org') continue;
      const url = parsed.toString();
      if (used.has(url) || picked.some((entry) => entry.url === url)) continue;
      picked.push({ title: String(result.title || '').trim() || parsed.hostname.replace(/^www\./i, ''), url });
    } catch {
      // not a usable URL
    }
    if (picked.length >= KNOWLEDGE_REFERENCES_PER_CHAPTER) break;
  }
  return picked;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Reference lookup timed out.')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Gives every reference-less chapter of a model-knowledge book links to follow. Live results are tried first (one short
 * query per chapter; the first failed lookup stops further ones so an unreachable search cannot delay the book); chapters
 * left without any get search links. The generation notice says which kind of links the book contains.
 */
export async function attachKnowledgeReferences(
  book: WebBook,
  options?: EngineOptions,
  lookup: ReferenceLookup = fetchGoogleSearchFallback
): Promise<WebBook> {
  const targets = book.chapters
    .map((chapter, index) => ({ chapter, index }))
    .filter(({ chapter }) => !Array.isArray(chapter.sourceUrls) || chapter.sourceUrls.length === 0);
  if (targets.length === 0) return book;

  const liveByChapter = new Map<number, Array<{ title: string; url: string }>>();
  const searchOptions: EngineOptions = options || { mode: 'google_duckduckgo' };

  if (searchOptions.mode !== 'off') {
    const used = new Set<string>();
    const results = await runBounded(
      targets.length,
      KNOWLEDGE_REFERENCE_CONCURRENCY,
      async (i) => {
        const { chapter, index } = targets[i];
        const payload = await withTimeout(
          lookup(buildReferenceQuery(book.topic, chapter.title), searchOptions),
          KNOWLEDGE_REFERENCE_LOOKUP_TIMEOUT_MS
        );
        const picked = pickReferenceResults(payload, used);
        picked.forEach((entry) => used.add(entry.url));
        if (picked.length > 0) liveByChapter.set(index, picked);
        return picked.length;
      },
      () => true
    );
    void results;
  }

  let liveChapters = 0;
  let linkChapters = 0;
  const chapters = book.chapters.map((chapter, index) => {
    if (!targets.some((target) => target.index === index)) return chapter;
    const live = liveByChapter.get(index);
    if (live && live.length > 0) {
      liveChapters += 1;
      return { ...chapter, sourceUrls: live };
    }
    const links = buildReferenceSearchLinks(book.topic, chapter.title);
    if (links.length > 0) linkChapters += 1;
    return { ...chapter, sourceUrls: links };
  });

  const notes: string[] = [];
  if (liveChapters > 0) {
    notes.push('Chapter reference links are related pages found by a live search for each chapter\'s subject; they were not used to write the text.');
  }
  if (linkChapters > 0) {
    notes.push(
      liveChapters > 0
        ? 'Chapters without a live result list search links (Wikipedia, Google Scholar) instead.'
        : 'No live sources could be retrieved, so chapter references are search links (Wikipedia, Google Scholar) for checking the content; they are not cited sources.'
    );
  }

  return {
    ...book,
    chapters,
    generationNote: [book.generationNote, ...notes].filter(Boolean).join(' '),
  };
}

async function assembleWebBookCore(
  optimalPopulation: WebPageGenotype[],
  topic: string,
  searchResult?: any,
  options?: EngineOptions
): Promise<WebBook> {
  const verifiedSourcesPool: Array<{ title: string; url: string }> = [];
  const poolSeen = new Set<string>();

  const addCandidateSource = (title?: string, url?: string) => {
    const cleanUrl = String(url || '').trim();
    if (!cleanUrl || !/^https?:\/\//i.test(cleanUrl) || poolSeen.has(cleanUrl)) return;
    try {
      const u = new URL(cleanUrl);
      if (u.hostname.includes('source-') || u.hostname === 'knowledge-base.org') return;
      poolSeen.add(cleanUrl);
      verifiedSourcesPool.push({
        title: String(title || u.hostname).trim(),
        url: cleanUrl,
      });
    } catch {
      // ignore
    }
  };

  optimalPopulation.forEach(p => addCandidateSource(p.title, p.url));
  (searchResult?.artifacts?.groundingChunks || []).forEach((c: any) => {
    addCandidateSource(c.web?.title || c.title, c.web?.uri || c.uri);
  });

  const assemblyPages = selectAssemblyPages(optimalPopulation);
  const evidenceDigest = buildEvidenceDigest(assemblyPages);
  const evidenceLabel = searchResult?.sourceMode === 'model_knowledge'
    ? 'Background notes written from the model\'s own knowledge (not live sources)'
    : 'Research evidence gathered from live sources';

  const preferredModel = options?.geminiModel || DEFAULT_GEMINI_MODEL;
  let assemblyFailure: unknown = null;

  const usedModelsCount = new Map<string, number>();
  const trackModel = (res: any) => {
    const m = res?._modelUsed;
    if (m) {
      usedModelsCount.set(m, (usedModelsCount.get(m) || 0) + 1);
    }
  };

  const appendFailoverNote = (baseNote: string) => {
    const failoverEntries = [...usedModelsCount.entries()].filter(([m]) => m !== preferredModel);
    if (failoverEntries.length === 0) return baseNote;
    const totalFailoverRequests = failoverEntries.reduce((sum, [_, count]) => sum + count, 0);
    const failoverModelNames = failoverEntries.map(([m]) => m).join(', ');
    const noteStr = `${totalFailoverRequests} chapter request${totalFailoverRequests === 1 ? '' : 's'} were answered by ${failoverModelNames} instead of the selected ${preferredModel}.`;
    return baseNote ? `${baseNote} ${noteStr}` : noteStr;
  };

  try {
    // Stage 1: Generate detailed 10-chapter outline
    const outlineResponse = await generateWithModelFallback({
      contents: `Topic: ${topic}.
      ${evidenceLabel}:
      ${evidenceDigest}

      Create a detailed outline of exactly ${BOOK_CHAPTER_COUNT} chapters (no more, no fewer; no separate conclusion or epilogue chapter beyond them) for a comprehensive, full-length Web-book. 
      For each chapter, provide:
      1. A compelling title.
      2. A brief 2-sentence focus description.
      3. 4 key terms to define.
      4. 3 sub-topics to explore.
      5. A short visual-concept caption for an image, written in the same language as the topic and the chapter titles (never English for a non-English book).
      Make the chapters cover different ground so that no chapter repeats another. Write titles without chapter numbers.`,
      config: {
        systemInstruction: "You are a master book architect. Output valid JSON only. Create an outline of exactly 10 chapters that flows logically from introduction to advanced concepts and future outlook. Ensure all terms and sub-topics are meaningful and relevant to the topic. Strictly avoid placeholders, random strings, or meaningless identifiers.",
        responseMimeType: "application/json",
        maxOutputTokens: 8192,
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            topic: { type: Type.STRING },
            outline: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING },
                  focus: { type: Type.STRING },
                  terms: { type: Type.ARRAY, items: { type: Type.STRING } },
                  subTopicTitles: { type: Type.ARRAY, items: { type: Type.STRING } },
                  visualSeed: { type: Type.STRING }
                },
                required: ["title", "focus", "terms", "subTopicTitles", "visualSeed"]
              }
            }
          },
          required: ["topic", "outline"]
        }
      }
    }, preferredModel);

    trackModel(outlineResponse);
    const outlineData = parseJsonObject(outlineResponse.text);

    if (outlineData && Array.isArray(outlineData.outline) && outlineData.outline.length > 0) {
      const outline: any[] = outlineData.outline.slice(0, BOOK_CHAPTER_COUNT);
      const outlineTitles = outline.map((entry, index) => `${index + 1}. ${entry?.title}`).join('\n');

      // Stage 2: chapter expansion, a few requests at a time, each written from the gathered evidence.
      const buildChapter = async (chapterOutline: any, chapterIndex: number) => {
        const chapterResponse = await generateWithModelFallback({
          contents: `Topic: ${topic}.
          Book outline (context only; write ONLY chapter ${chapterIndex + 1} and do not repeat what belongs to the other chapters):
          ${outlineTitles}

          Chapter ${chapterIndex + 1}: ${chapterOutline.title}. Focus: ${chapterOutline.focus}.

          ${evidenceLabel} (ground the chapter in it; never invent facts, figures or URLs):
          ${evidenceDigest}

          Write a comprehensive, high-quality chapter of ${CHAPTER_TARGET_WORDS.min}-${CHAPTER_TARGET_WORDS.max} words (for Chinese, Japanese or Korean, roughly ${CHAPTER_TARGET_WORDS.min * 2}-${CHAPTER_TARGET_WORDS.max * 2} characters) in 5 to 7 well-developed paragraphs separated by blank lines. Include concrete facts, examples, mechanisms and trade-offs from the evidence.
          Also provide detailed definitions (2-4 sentences each) for: ${(chapterOutline.terms || []).join(', ')}.
          And detailed analyses (3-5 sentences each) for the sub-topics: ${(chapterOutline.subTopicTitles || []).join(', ')}.
          The "content" field is the narrative only: do NOT put the term definitions or the sub-topic analyses inside it (they are returned in the "definitions" and "subTopics" fields and printed separately), do not add lists of key concepts, and do not restate them. Write everything in the same language as the topic.
          Formatting: plain text only. No Markdown at all (no #, ##, ###, ** or bullet symbols) and no heading line that repeats the chapter title or number; always close every parenthesis you open; put each term in the "term" field exactly as given, without a trailing colon.`,
          config: {
            systemInstruction: "You are an expert technical writer. Output valid JSON only. Be detailed, authoritative, and academic in tone. Ensure all definitions and sub-topic analyses are meaningful, human-readable, and relevant to the chapter. Strictly avoid generating random numbers, long strings of digits, or meaningless placeholder text.",
            responseMimeType: "application/json",
            maxOutputTokens: 8192,
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                content: { type: Type.STRING },
                definitions: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      term: { type: Type.STRING },
                      description: { type: Type.STRING }
                    }
                  }
                },
                subTopics: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      title: { type: Type.STRING },
                      summary: { type: Type.STRING }
                    }
                  }
                }
              },
              required: ["content", "definitions", "subTopics"]
            }
          }
        }, preferredModel);

        trackModel(chapterResponse);

        const chapterData = parseJsonObject(chapterResponse.text);
        const chapterContent = cleanChapterContent(String(chapterData?.content || ''), String(chapterOutline?.title || ''));
        // An empty or tiny chapter used to be replaced by a canned "Comprehensive exploration of ... reveals
        // interconnected principles" sentence. That is filler presented as research, so the chapter fails instead.
        if (countWords(chapterContent) < MIN_ACCEPTABLE_CHAPTER_WORDS) {
          throw new SyntaxError(`Gemini returned no usable text for chapter "${chapterOutline.title}"`);
        }

        const chapterSourceIndex = chapterIndex % Math.max(1, verifiedSourcesPool.length);
        const chapterSources = verifiedSourcesPool.length > 0
          ? [
              verifiedSourcesPool[chapterSourceIndex],
              verifiedSourcesPool[(chapterSourceIndex + 1) % verifiedSourcesPool.length],
            ].filter(Boolean)
          : [];
        const primaryUrl = chapterSources[0]?.url || (verifiedSourcesPool[0]?.url || '');

        const rawChapterTitle = String(chapterOutline?.title || '').trim();
        const cleanChapterTitle = rawChapterTitle
          .replace(CHAPTER_NUMBER_PREFIX, '')
          .replace(/^[:：\-–—.\s]+|[:：\-–—.\s]+$/g, '')
          .trim() || rawChapterTitle || `Chapter ${chapterIndex + 1}`;

        return {
          title: cleanChapterTitle,
          content: chapterContent,
          definitions: (chapterData?.definitions || [])
            .filter((d: any) => isMeaningful(d.term, d.description))
            .map((d: any) => ({ ...d, term: cleanTermLabel(d.term), description: cleanChapterContent(String(d.description || '')), sourceUrl: primaryUrl })),
          subTopics: (chapterData?.subTopics || [])
            .filter((s: any) => isMeaningful(s.title, s.summary))
            .map((s: any) => ({ ...s, title: cleanTermLabel(s.title), summary: cleanChapterContent(String(s.summary || '')), sourceUrl: primaryUrl })),
          sourceUrls: chapterSources.length > 0 ? chapterSources : verifiedSourcesPool.slice(0, 3),
          visualSeed: chapterOutline.visualSeed || `${topic} ${cleanChapterTitle}`,
        } as Chapter;
      };

      const results = await runBounded(
        outline.length,
        CHAPTER_CONCURRENCY,
        (index) => buildChapter(outline[index], index),
        (error) => NON_RECOVERABLE_GEMINI_REASONS.has(detectGeminiFailureReason(error))
      );

      const chapters: Chapter[] = results.flatMap((result) => (result.status === 'ok' ? [result.value] : []));

      if (chapters.length > 0) {
        // One failed chapter no longer discards the others. The book keeps every chapter that was written, and the
        // notice says plainly which ones are missing and why, instead of padding them.
        const missing = results
          .map((result, index) => ({ result, index }))
          .filter(({ result }) => result.status !== 'ok');
        const firstFailure = results.find((result): result is { status: 'failed'; error: unknown } => result.status === 'failed');
        let partialNote = '';
        if (missing.length > 0) {
          const cause = classifyGeminiSearchFailure(firstFailure?.error);
          const titles = missing.slice(0, 3).map(({ index }) => `"${outline[index]?.title}"`).join(', ');
          const retryHint = NON_RECOVERABLE_GEMINI_REASONS.has(detectGeminiFailureReason(firstFailure?.error))
            ? ''
            : ' Search again in a minute to get a complete book.';
          partialNote = ` ${chapters.length} of ${outline.length} chapters were written; ${missing.length} could not be generated (${GEMINI_SEARCH_CAUSE_PHRASES[cause]}) and are left out rather than padded: ${titles}${missing.length > 3 ? ', ...' : ''}.${retryHint}`;
        }

        return {
          id: `book-${Date.now()}`,
          topic: outlineData.topic || topic,
          timestamp: Date.now(),
          chapters,
          sourceMode: searchResult?.sourceMode || 'gemini',
          generationNote: appendFailoverNote(`${searchResult?.generationNote || 'Assembled via 2-stage evolutionary architecture.'}${partialNote}`),
          fallbackSource: searchResult?.fallbackSource,
          fallbackReason: searchResult?.fallbackReason,
        };
      }

      const firstFailure = results.find((result): result is { status: 'failed'; error: unknown } => result.status === 'failed');
      assemblyFailure = firstFailure?.error ?? new SyntaxError('Gemini returned no chapters');
    } else {
      assemblyFailure = new SyntaxError('Gemini returned an empty book outline');
    }
  } catch (err) {
    console.warn("AI outline / chapter expansion failed, falling back to resilient synthesis...", err);
    assemblyFailure = err;
  }

  // Gemini-only mode never recovers silently: report the failure instead of presenting an offline book.
  if (options?.mode === 'off' && assemblyFailure) {
    const cause = classifyGeminiSearchFailure(assemblyFailure);
    if (cause === 'model_unavailable') {
      throw new Error(`Selected Gemini model: ${preferredModel} is not available. Choose another model and try again.`);
    }
    if (cause === 'no_content') {
      throw new Error(`Selected Gemini model: ${preferredModel} returned no usable book content. Please try again.`);
    }
    throw new Error(buildGeminiUserFacingErrorMessage(assemblyFailure, detectGeminiFailureReason(assemblyFailure)));
  }

  // Graceful resilient fallback synthesis: ensures no alerts/crashes when Gemini quota is met.
  // The notice must describe what really happened, not the (successful) search step that preceded it.
  if (assemblyFailure) {
    const cause = classifyGeminiSearchFailure(assemblyFailure);
    const assemblyNote = `Selected Gemini model: ${preferredModel} unavailable for book assembly (${cause === 'no_content' ? 'no usable content returned' : GEMINI_SEARCH_CAUSE_PHRASES[cause]}); book text assembled offline from the gathered evidence.`;
    const searchWasGemini = searchResult?.sourceMode === 'gemini';
    return synthesizeFallbackWebBook(topic, optimalPopulation, {
      ...(searchResult || {}),
      sourceMode: searchWasGemini ? 'hybrid' : (searchResult?.sourceMode || 'fallback_search'),
      generationNote: `${searchResult?.generationNote ? `${searchResult.generationNote} ` : ''}${assemblyNote}`,
      fallbackReason: searchResult?.fallbackReason ?? GEMINI_SEARCH_CAUSE_TO_FALLBACK_REASON[cause],
    });
  }
  return synthesizeFallbackWebBook(topic, optimalPopulation, searchResult);
}

export async function assembleWebBook(
  optimalPopulation: WebPageGenotype[],
  topic: string,
  searchResult?: any,
  options?: EngineOptions
): Promise<WebBook> {
  const book = await assembleWebBookCore(optimalPopulation, topic, searchResult, options);
  // Books written from the model's own knowledge have no source pages; give their chapters something to follow.
  return book.sourceMode === 'model_knowledge' ? attachKnowledgeReferences(book, options) : book;
}
