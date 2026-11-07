export interface Definition {
  term: string;
  description: string;
  sourceUrl: string;
}

export interface SubTopic {
  title: string;
  summary: string;
  sourceUrl: string;
}

export interface WebPageGenotype {
  id: string;
  url: string;
  title: string;
  content: string;
  definitions: Definition[];
  subTopics: SubTopic[];
  informativeScore: number; // I(w)
  authorityScore: number;   // A(w)
  fitness: number;          // F(w)
}

export type ChapterSourceUrl = string | { title: string; url: string };

export interface Chapter {
  title: string;
  content: string;
  definitions: Definition[];
  subTopics: SubTopic[];
  sourceUrls: ChapterSourceUrl[];
  visualSeed: string; // Keyword for image generation
}

export const GEMINI_MODELS = [
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.7-flash',
  'gemini-3.8-flash',
  'gemini-flash-latest',
  'gemini-3.5-flash-lite',
] as const;

export type SearchFallbackMode = 'off' | 'duckduckgo' | 'google' | 'google_duckduckgo';
export type SearchFallbackSource = 'google' | 'duckduckgo' | 'google_duckduckgo' | 'gemini';
export type SearchFallbackReason = 'quota_exhausted' | 'rate_limited' | 'unreachable' | 'network_unreachable' | 'manual' | 'no_content' | 'invalid_api_key' | 'missing_api_key' | 'service_unavailable';
export type WebBookSourceMode = 'gemini' | 'fallback_search' | 'hybrid' | 'search-fallback' | 'model_knowledge';
export type SearchFallbackProvider = 'google' | 'duckduckgo';

export interface SearchArtifact {
  title?: string;
  url?: string;
  snippet?: string;
  source?: SearchFallbackProvider;
  web?: { title: string; uri: string };
}

export interface SearchFallbackResult {
  title: string;
  url: string;
  snippet: string;
  source?: SearchFallbackProvider;
  domain?: string;
  excerpt?: string;
}

export interface SearchFallbackPayload {
  query: string;
  provider: SearchFallbackProvider | 'google_duckduckgo';
  results: SearchFallbackResult[];
  timestamp?: number;
  extractedAt?: number;
  summary?: string;
  diagnostics?: string[];
  source?: string;
  aiOverview?: any[];
  mode?: SearchFallbackMode;
}

export interface EngineOptions {
  mode: SearchFallbackMode;
  geminiModel?: string;
  maxGenerations?: number;
}

export function isSearchFallbackMode(val: unknown): val is SearchFallbackMode {
  return typeof val === 'string' && ['off', 'duckduckgo', 'google', 'google_duckduckgo'].includes(val);
}

export function isSearchFallbackReason(val: unknown): val is SearchFallbackReason {
  return typeof val === 'string' && ['quota_exhausted', 'rate_limited', 'unreachable', 'network_unreachable', 'manual', 'no_content', 'invalid_api_key', 'missing_api_key', 'service_unavailable'].includes(val);
}

export function isSearchFallbackSource(val: unknown): val is SearchFallbackSource {
  return typeof val === 'string' && ['google', 'duckduckgo', 'google_duckduckgo', 'gemini'].includes(val);
}

/**
 * True when the book was written from scraped search snippets only (no Gemini synthesis). The engine emits
 * 'fallback_search' and the search server emits 'search-fallback'; both mean the same thing and must be treated alike.
 */
export function isSnippetOnlySourceMode(mode: unknown): boolean {
  return mode === 'fallback_search' || mode === 'search-fallback';
}

export function isWebBookSourceMode(val: unknown): val is WebBookSourceMode {
  return typeof val === 'string' && ['gemini', 'fallback_search', 'hybrid', 'search-fallback', 'model_knowledge'].includes(val);
}

export interface WebBook {
  id: string;
  topic: string;
  timestamp: number;
  chapters: Chapter[];
  sourceMode?: WebBookSourceMode;
  generationNote?: string;
  completedGenerations?: number;
  fallbackSource?: SearchFallbackSource;
  fallbackReason?: SearchFallbackReason;
}

export interface EvolutionState {
  generation: number;
  population: WebPageGenotype[];
  bestFitness: number;
  status: 'idle' | 'searching' | 'parsing' | 'evolving' | 'assembling' | 'complete';
  artifacts?: {
    searchSummary?: string;
    rawSearchResults?: any[];
    evolvedPopulation?: WebPageGenotype[];
    assemblyInput?: WebPageGenotype[];
    assemblyOutput?: WebBook;
    [key: string]: unknown;
  };
  generationNote?: string;
  completedGenerations?: number;
  bestRedundancyPenalty?: number;
  bestInformativeScore?: number;
  bestAuthorityScore?: number;
}

export enum Type {
  TYPE_UNSPECIFIED = "TYPE_UNSPECIFIED",
  STRING = "STRING",
  NUMBER = "NUMBER",
  INTEGER = "INTEGER",
  BOOLEAN = "BOOLEAN",
  ARRAY = "ARRAY",
  OBJECT = "OBJECT",
  NULL = "NULL",
}
