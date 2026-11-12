import { useEffect, useRef, useState } from 'react';
import type { EngineOptions, EvolutionState, SearchFallbackMode, WebBook } from '../types';
import {
  ASSEMBLY_SOURCE_POOL_SIZE,
  assembleWebBook,
  discoverAvailableGeminiModels,
  evolve,
  searchAndExtract,
} from '../services/evolutionService';
import {
  clearPersistedSearches,
  completePersistedSearch,
  createPersistedSearch,
  deletePersistedSearch,
  failPersistedSearch,
  loadLocalHistoryBooks,
  loadPersistedWebBooks,
  loadServerPersistedWebBooks,
  mergeHistoryBooks,
  persistWebBookTextToServer,
  saveLocalHistoryBooks,
} from '../services/historyService';

const INITIAL_STATE: EvolutionState = {
  generation: 0,
  population: [],
  bestFitness: 0,
  status: 'idle',
  artifacts: {},
};

const CANCELLED_SEARCH_ERROR_NAME = 'CancelledSearchError';
const CANCELLED_SEARCH_MESSAGE = 'Search cancelled by user.';

function createCancelledSearchError(): Error {
  const error = new Error(CANCELLED_SEARCH_MESSAGE);
  error.name = CANCELLED_SEARCH_ERROR_NAME;
  return error;
}

function isCancelledSearchError(error: unknown): boolean {
  return error instanceof Error && error.name === CANCELLED_SEARCH_ERROR_NAME;
}

export function useWebBookEngine() {
  const activeRunIdRef = useRef(0);
  const isInitialMountRef = useRef(true);

  // Lazily restore history from localStorage to avoid StrictMode double-mount wiping storage with []
  const [history, setHistory] = useState<WebBook[]>(() => loadLocalHistoryBooks());

  // Restore the latest book on refresh so a page refresh does not remove what the user queried or generated
  const [webBook, setWebBook] = useState<WebBook | null>(() => {
    const local = loadLocalHistoryBooks();
    return local.length > 0 ? local[0] : null;
  });

  const [query, setQuery] = useState<string>(() => {
    const local = loadLocalHistoryBooks();
    return local.length > 0 ? local[0].topic : '';
  });

  const [state, setState] = useState<EvolutionState>(() => {
    const local = loadLocalHistoryBooks();
    if (local.length > 0) {
      const first = local[0];
      return {
        generation: first.completedGenerations ?? 3,
        population: [],
        bestFitness: 0,
        status: 'complete',
        artifacts: {},
      };
    }
    return INITIAL_STATE;
  });

  const [error, setError] = useState<string | null>(null);

  const [notice, setNotice] = useState<string | null>(() => {
    const local = loadLocalHistoryBooks();
    return local.length > 0 ? (local[0].generationNote || null) : null;
  });

  // History item being browsed while a generation keeps running in the background.
  // The live run state (state/query/notice/error) is never touched while this is set.
  const [viewingItem, setViewingItemState] = useState<WebBook | null>(null);
  const viewingItemRef = useRef<WebBook | null>(null);
  const [runTopic, setRunTopic] = useState<string>('');
  // Outcome of a run that finished while the user was away browsing history.
  const [backgroundOutcome, setBackgroundOutcome] = useState<'complete' | 'failed' | null>(null);

  const setViewingItem = (item: WebBook | null) => {
    viewingItemRef.current = item;
    setViewingItemState(item);
  };

  const [fallbackMode, setFallbackMode] = useState<SearchFallbackMode>('google_duckduckgo');
  const [geminiModel, setGeminiModel] = useState<EngineOptions['geminiModel']>('gemini-3.6-flash');

  useEffect(() => {
    const local = loadLocalHistoryBooks();
    if (local.length > 0) {
      // Best-effort auto-persist existing local book to server disk in case it was generated prior
      void persistWebBookTextToServer(local[0]).catch(() => {});
    }
    void discoverAvailableGeminiModels();
  }, []);

  useEffect(() => {
    let isMounted = true;

    const syncPersistedHistory = async () => {
      try {
        const [persistedHistory, serverDiskHistory] = await Promise.all([
          loadPersistedWebBooks().catch(() => []),
          loadServerPersistedWebBooks().catch(() => []),
        ]);
        if (!isMounted) return;
        const combined = [...persistedHistory, ...serverDiskHistory];
        if (combined.length > 0) {
          setHistory((previousHistory) => mergeHistoryBooks(previousHistory, combined));
        }
      } catch (persistenceError) {
        console.error('Failed to load persisted history', persistenceError);
      }
    };

    void syncPersistedHistory();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (isInitialMountRef.current) {
      isInitialMountRef.current = false;
      return;
    }
    saveLocalHistoryBooks(history);
  }, [history]);

  const beginRun = (): number => {
    const nextRunId = activeRunIdRef.current + 1;
    activeRunIdRef.current = nextRunId;
    return nextRunId;
  };

  const isActiveRun = (runId: number): boolean => activeRunIdRef.current === runId;

  const startNewSearch = () => {
    beginRun();
    setViewingItem(null);
    setBackgroundOutcome(null);
    setRunTopic('');
    setQuery('');
    setWebBook(null);
    setError(null);
    setNotice(null);
    setState(INITIAL_STATE);
  };

  const runSearch = async () => {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) return;
    const runId = beginRun();
    setViewingItem(null);
    setBackgroundOutcome(null);
    setRunTopic(trimmedQuery);

    const ensureActiveRun = () => {
      if (!isActiveRun(runId)) {
        throw createCancelledSearchError();
      }
    };

    setState({ ...INITIAL_STATE, status: 'searching' });
    setWebBook(null);
    setError(null);
    setNotice(null);

    let persistedSearchId: string | null = null;

    try {
      try {
        persistedSearchId = await createPersistedSearch(trimmedQuery);
        ensureActiveRun();
      } catch (persistenceError) {
        console.error('Failed to create persisted search record', persistenceError);
      }

      const searchResult = await searchAndExtract(trimmedQuery, { mode: fallbackMode, geminiModel });
      ensureActiveRun();
      const initialPopulation = searchResult.results;
      if (initialPopulation.length === 0) {
        throw new Error(
          `No usable external evidence was gathered for "${trimmedQuery}", so WebBook assembly was skipped.`
        );
      }
      const initialBest = initialPopulation.length > 0
        ? initialPopulation.reduce((previous, current) => (
          previous.informativeScore + previous.authorityScore > current.informativeScore + current.authorityScore
            ? previous
            : current
        ))
        : null;

      setNotice(searchResult.generationNote || null);
      setState((previousState) => ({
        ...previousState,
        status: 'evolving',
        population: initialPopulation,
        bestInformativeScore: initialBest?.informativeScore || 0,
        bestAuthorityScore: initialBest?.authorityScore || 0,
        bestRedundancyPenalty: 0,
        artifacts: {
          ...previousState.artifacts,
          rawSearchResults: searchResult.artifacts.groundingChunks,
          searchSummary: searchResult.artifacts.searchSummary,
        },
      }));

      const { population: evolvedPopulation, completedGenerations, bestRedundancyPenalty } = await evolve(initialPopulation);
      ensureActiveRun();
      if (evolvedPopulation.length === 0) {
        throw new Error(
          `No usable source pages remained after evolution for "${trimmedQuery}", so the WebBook could not be assembled.`
        );
      }
      const bestEvolved = evolvedPopulation.length > 0
        ? evolvedPopulation.reduce((previous, current) => previous.fitness > current.fitness ? previous : current)
        : null;

      setState((previousState) => ({
        ...previousState,
        status: 'assembling',
        population: evolvedPopulation,
        bestFitness: bestEvolved?.fitness || 0,
        bestInformativeScore: bestEvolved?.informativeScore || 0,
        bestAuthorityScore: bestEvolved?.authorityScore || 0,
        bestRedundancyPenalty,
        artifacts: {
          ...previousState.artifacts,
          evolvedPopulation,
        },
      }));

      const assembledBook = await assembleWebBook(evolvedPopulation, trimmedQuery, searchResult, { mode: fallbackMode, geminiModel });
      ensureActiveRun();
      const bookWithGenerations = {
        ...assembledBook,
        completedGenerations,
      };
      const book = persistedSearchId ? { ...bookWithGenerations, id: persistedSearchId } : bookWithGenerations;

      setWebBook(book);
      setNotice(book.generationNote || searchResult.generationNote || null);
      setHistory((previousHistory) => mergeHistoryBooks([book], previousHistory));
      if (viewingItemRef.current) {
        setBackgroundOutcome('complete');
      }

      void completePersistedSearch(persistedSearchId, trimmedQuery, book).catch((persistenceError) => {
        console.error('Failed to persist completed WebBook', persistenceError);
      });

      // Auto-persist formatted WebBook text to server saved_webbooks/ folder
      void persistWebBookTextToServer(book).catch((saveErr) => {
        console.warn('Failed to auto-persist WebBook to server disk', saveErr);
      });

      setState((previousState) => ({
        ...previousState,
        status: 'complete',
        generation: completedGenerations,
        population: evolvedPopulation,
        bestFitness: bestEvolved?.fitness || 0,
        bestInformativeScore: bestEvolved?.informativeScore || 0,
        bestAuthorityScore: bestEvolved?.authorityScore || 0,
        bestRedundancyPenalty,
        artifacts: {
          ...previousState.artifacts,
          assemblyInput: evolvedPopulation.slice(0, ASSEMBLY_SOURCE_POOL_SIZE),
          assemblyOutput: book,
        },
      }));
    } catch (runtimeError: any) {
      if (!isActiveRun(runId) || isCancelledSearchError(runtimeError)) {
        if (persistedSearchId) {
          void failPersistedSearch(persistedSearchId, trimmedQuery, CANCELLED_SEARCH_MESSAGE).catch((persistenceError) => {
            console.error('Failed to persist cancelled search', persistenceError);
          });
        }
        return;
      }

      console.error('Evolution error:', runtimeError);
      let message = runtimeError?.message || 'An unexpected error occurred during evolution.';
      const isRawGeminiRateLimit =
        (message.includes('429') || message.includes('quota') || message.includes('RESOURCE_EXHAUSTED')) &&
        !message.includes('no external evidence could be gathered');
      if (isRawGeminiRateLimit) {
        message = 'The AI engine is currently busy or has reached its rate limit. Please wait a minute and try again.';
      }

      void failPersistedSearch(persistedSearchId, trimmedQuery, message).catch((persistenceError) => {
        console.error('Failed to persist failed search', persistenceError);
      });

      setError(message);
      setNotice(null);
      setState(INITIAL_STATE);
      if (viewingItemRef.current) {
        setBackgroundOutcome('failed');
      }
    }
  };

  const isRunInProgress =
    state.status === 'searching' || state.status === 'evolving' || state.status === 'assembling' || state.status === 'parsing';

  const returnToRun = () => {
    setViewingItem(null);
    setBackgroundOutcome(null);
  };

  const viewHistoryItem = (item: WebBook) => {
    if (isRunInProgress) {
      // Browse the archived book without disturbing the generation that is still running.
      setViewingItem(item);
      return;
    }
    setViewingItem(null);
    setBackgroundOutcome(null);
    setWebBook(item);
    setQuery(item.topic);
    setError(null);
    setNotice(item.generationNote || null);
    setState({
      generation: item.completedGenerations ?? 3,
      population: [],
      bestFitness: 0,
      status: 'complete',
      artifacts: {},
    });
  };

  const deleteHistoryItem = (id: string) => {
    setHistory((previousHistory) => previousHistory.filter((item) => item.id !== id));
    if (viewingItemRef.current?.id === id) {
      setViewingItem(null);
    }
    if (webBook?.id === id) {
      startNewSearch();
    }

    void deletePersistedSearch(id).catch((persistenceError) => {
      console.error('Failed to delete persisted history item', persistenceError);
    });
  };

  const clearAllHistory = () => {
    if (!window.confirm('Are you sure you want to delete all search history?')) {
      return;
    }

    setHistory([]);
    setViewingItem(null);
    if (webBook) {
      startNewSearch();
    }

    void clearPersistedSearches().catch((persistenceError) => {
      console.error('Failed to clear persisted history', persistenceError);
    });
  };

  return {
    query,
    setQuery,
    state,
    webBook,
    history,
    error,
    notice,
    fallbackMode,
    setFallbackMode,
    geminiModel,
    setGeminiModel,
    runSearch,
    startNewSearch,
    viewHistoryItem,
    deleteHistoryItem,
    clearAllHistory,
    viewingItem,
    runTopic,
    backgroundOutcome,
    isRunInProgress,
    returnToRun,
  };
}
