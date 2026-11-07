import type { SearchFallbackResult } from '../../src/types.ts';

export interface SearchFetchResult {
  readonly label: string;
  readonly url: string;
  readonly status: number;
  readonly html: string;
}

export interface DuckDuckGoEvidence {
  readonly attempts: ReadonlyArray<SearchFetchResult>;
  readonly liteAttempts: ReadonlyArray<SearchFetchResult>;
  readonly instantAnswer: { readonly status: number; readonly results: ReadonlyArray<SearchFallbackResult> } | null;
  readonly results: ReadonlyArray<SearchFallbackResult>;
  readonly diagnostics: ReadonlyArray<string>;
}

export interface GoogleEvidence {
  readonly attempts: ReadonlyArray<SearchFetchResult>;
  readonly results: ReadonlyArray<SearchFallbackResult>;
  readonly aiOverview: ReadonlyArray<string>;
  readonly diagnostics: ReadonlyArray<string>;
  readonly didBlock: boolean;
  readonly noResults: boolean;
}
