import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertCircle,
  ChevronDown,
  Cpu,
  Dna,
  Info,
  Layers,
  Loader2,
  Plus,
  Search,
  X,
} from 'lucide-react';
import type { EvolutionState, SearchFallbackMode, WebPageGenotype } from '../types';
import { GEMINI_MODELS } from '../types';
import { discoverAvailableGeminiModels } from '../services/evolutionService';

const QUERY_PREVIEW_LINE_THRESHOLD = 4;
const FALLBACK_MODE_OPTIONS: Array<{
  value: SearchFallbackMode;
  label: string;
}> = [
  {
    value: 'google_duckduckgo',
    label: 'Google + DuckDuckGo',
  },
  {
    value: 'google',
    label: 'Google only',
  },
  {
    value: 'duckduckgo',
    label: 'DuckDuckGo only',
  },
  {
    value: 'off',
    label: 'Off (Gemini only)',
  },
];

function getFallbackModeHelperText(mode: SearchFallbackMode): string {
  if (mode === 'off') {
    return 'Gemini-only mode. No Google Search or DuckDuckGo recovery will run if Gemini search or extraction fails.';
  }

  return 'Used only if Gemini needs recovery or supplemental search evidence.';
}

function getRenderedTextareaLineCount(element: HTMLTextAreaElement): number {
  const style = window.getComputedStyle(element);
  const computedLineHeight = Number.parseFloat(style.lineHeight);
  const computedFontSize = Number.parseFloat(style.fontSize);
  const lineHeight = Number.isFinite(computedLineHeight)
    ? computedLineHeight
    : computedFontSize * 1.2;
  const paddingTop = Number.parseFloat(style.paddingTop) || 0;
  const paddingBottom = Number.parseFloat(style.paddingBottom) || 0;
  const contentHeight = Math.max(0, element.scrollHeight - paddingTop - paddingBottom);

  if (!lineHeight || contentHeight <= 0) {
    return 1;
  }

  return Math.max(1, Math.ceil((contentHeight - 1) / lineHeight));
}

interface ControlSidebarProps {
  query: string;
  onQueryChange: (value: string) => void;
  state: EvolutionState;
  error: string | null;
  notice: string | null;
  fallbackMode: SearchFallbackMode;
  onFallbackModeChange: (mode: SearchFallbackMode) => void;
  geminiModel?: string;
  onGeminiModelChange: (model: any) => void;
  showArtifacts: boolean;
  onToggleArtifacts: () => void;
  onSearch: () => Promise<void>;
  onStartNewSearch: () => void;
}

export function ControlSidebar({
  query,
  onQueryChange,
  state,
  error,
  notice,
  fallbackMode,
  onFallbackModeChange,
  geminiModel,
  onGeminiModelChange,
  showArtifacts,
  onToggleArtifacts,
  onSearch,
  onStartNewSearch,
}: ControlSidebarProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const artifactsRef = useRef<HTMLElement>(null);
  const [shouldShowQueryPreview, setShouldShowQueryPreview] = useState(false);
  const [isQueryPreviewActive, setIsQueryPreviewActive] = useState(false);
  const [tooltipPosition, setTooltipPosition] = useState<'top' | 'bottom'>('top');
  const [dynamicModels, setDynamicModels] = useState<string[]>([]);

  useEffect(() => {
    let isMounted = true;
    void discoverAvailableGeminiModels().then((models) => {
      if (isMounted && models.length > 0) {
        setDynamicModels(models);
      }
    });
    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (showArtifacts && artifactsRef.current) {
      const timer = window.setTimeout(() => {
        artifactsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 150);
      return () => window.clearTimeout(timer);
    }
  }, [showArtifacts]);

  useEffect(() => {
    if (isQueryPreviewActive && formRef.current) {
      const rect = formRef.current.getBoundingClientRect();
      setTooltipPosition(rect.top < 320 ? 'bottom' : 'top');
    }
  }, [isQueryPreviewActive, query, shouldShowQueryPreview]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 172)}px`;
    }
  }, [query]);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) {
      setShouldShowQueryPreview(false);
      return undefined;
    }

    const updateQueryPreviewState = () => {
      const trimmedQuery = query.trim();
      if (!trimmedQuery) {
        setShouldShowQueryPreview(false);
        return;
      }

      const renderedLineCount = getRenderedTextareaLineCount(element);
      setShouldShowQueryPreview(renderedLineCount >= QUERY_PREVIEW_LINE_THRESHOLD);
    };

    updateQueryPreviewState();

    const resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => updateQueryPreviewState())
      : null;

    resizeObserver?.observe(element);
    window.addEventListener('resize', updateQueryPreviewState);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', updateQueryPreviewState);
    };
  }, [query]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;

      if (!(target instanceof Node)) {
        return;
      }

      if (textareaRef.current?.contains(target)) {
        return;
      }

      setIsQueryPreviewActive(false);
    };

    document.addEventListener('pointerdown', handlePointerDown);

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, []);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    await onSearch();
  };

  const isBusy = state.status !== 'idle' && state.status !== 'complete';
  const progressWidthPct =
    state.status === 'complete'   ? '100%' :
    state.status === 'assembling' ? '80%'  :
    state.status === 'evolving'   ? '55%'  :
    state.status === 'searching'  ? '25%'  : '0%';
  const progressText = state.status === 'complete' ? '100%' : progressWidthPct;
  const searchSummary = state.artifacts?.searchSummary;
  const fallbackHelperText = getFallbackModeHelperText(fallbackMode);
  const evolutionWasSkipped = state.status === 'complete' && state.generation === 0;

  return (
    <div data-html2canvas-ignore="true" className="lg:col-span-4 space-y-8 print:hidden">
      <section className="bg-white border border-[#141414] p-6 shadow-[4px_4px_0px_0px_rgba(20,20,20,1)]">
        <div className="flex justify-between items-center mb-4">
          <h2 className="font-serif italic text-sm uppercase opacity-50">Targeted Ingestion</h2>
          <button
            onClick={onStartNewSearch}
            disabled={isBusy}
            title="Reset engine and start a new search"
            className="text-[10px] uppercase font-bold flex items-center gap-1 hover:underline disabled:opacity-50 disabled:no-underline disabled:cursor-not-allowed"
          >
            <Plus size={12} /> New Search
          </button>
        </div>

        <form
          ref={formRef}
          onSubmit={(event) => void handleSubmit(event)}
          className="relative"
        >
          <AnimatePresence>
            {shouldShowQueryPreview && isQueryPreviewActive && query && (
              <motion.div
                initial={{ opacity: 0, y: tooltipPosition === 'top' ? 10 : -10, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: tooltipPosition === 'top' ? 10 : -10, scale: 0.95 }}
                className={`absolute ${tooltipPosition === 'top' ? 'bottom-full mb-3' : 'top-full mt-3'} left-0 w-full z-[60] pointer-events-none`}
              >
                <div className="bg-yellow-300 text-[#141414] p-4 border-2 border-[#141414] shadow-[6px_6px_0px_0px_rgba(20,20,20,1)] text-sm font-mono break-words max-h-[40vh] overflow-y-auto custom-scrollbar pointer-events-auto">
                  <div className="flex items-center gap-2 mb-2 opacity-70 text-[10px] uppercase font-bold tracking-widest">
                    <Info size={12} className="text-[#141414]" /> Full Search Query Preview
                  </div>
                  <div className="leading-relaxed">{query}</div>
                  <div className="mt-2 text-[9px] opacity-40 italic">
                    Query spans four or more rendered lines. Showing full preview for accessibility.
                  </div>
                </div>
                <div className={`absolute ${tooltipPosition === 'top' ? '-bottom-2 border-r-2 border-b-2' : '-top-2 border-l-2 border-t-2'} left-8 w-4 h-4 bg-yellow-300 border-[#141414] rotate-45`} />
              </motion.div>
            )}
          </AnimatePresence>

          <textarea
            ref={textareaRef}
            rows={2}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search for topic..."
            className="w-full bg-[#F5F5F5] border border-[#141414] p-4 pr-14 focus:outline-none focus:ring-0 text-base sm:text-lg font-mono resize-none overflow-y-auto max-h-40"
            style={{ height: 'auto', minHeight: '84px' }}
            disabled={isBusy}
            onMouseEnter={() => setIsQueryPreviewActive(true)}
            onFocus={() => setIsQueryPreviewActive(true)}
            onClick={() => setIsQueryPreviewActive(true)}
            onBlur={() => setIsQueryPreviewActive(false)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void onSearch();
              }
            }}
          />
          <button
            type="submit"
            title="Execute evolutionary synthesis pipeline"
            className="absolute right-4 top-4 w-8 h-8 bg-[#141414] text-[#E4E3E0] flex items-center justify-center hover:bg-opacity-90 transition-colors disabled:opacity-50 shadow-[2px_2px_0px_0px_rgba(0,0,0,0.2)]"
            disabled={isBusy}
          >
            {isBusy ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
          </button>
        </form>

        <p className="mt-3 text-[10px] opacity-60 leading-relaxed">
          Initiates a multi-tiered pipeline: Targeted Crawling - NLP Extraction - Evolutionary Processing - Assembly.
        </p>

        <div className="mt-4">
          <div className="flex items-center gap-3">
            <label htmlFor="gemini-model" className="shrink-0 w-[72px] text-[10px] uppercase font-bold tracking-[0.18em] opacity-60">
              Model
            </label>
            <div className="relative flex-1">
              <select
                id="gemini-model"
                value={geminiModel || 'gemini-3.6-flash'}
                onChange={(event) => onGeminiModelChange(event.target.value)}
                disabled={isBusy}
                title="Choose which Gemini model to use"
                className="w-full appearance-none bg-[#F5F5F5] border border-[#141414] px-3 py-2 pr-9 text-[11px] font-mono focus:outline-none disabled:opacity-50"
              >
                {Array.from(new Set([
                  ...GEMINI_MODELS,
                  ...dynamicModels,
                  ...(geminiModel ? [geminiModel] : []),
                ])).map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
              <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none opacity-60" />
            </div>
          </div>
          <div className="flex items-center gap-3 mt-4">
            <label htmlFor="fallback-mode" className="shrink-0 w-[72px] text-[10px] uppercase font-bold tracking-[0.18em] opacity-60">
              Fallback
            </label>
            <div className="relative flex-1">
              <select
                id="fallback-mode"
                value={fallbackMode}
                onChange={(event) => onFallbackModeChange(event.target.value as SearchFallbackMode)}
                disabled={isBusy}
                title="Choose how live fallback search should behave when Gemini needs recovery"
                className="w-full appearance-none bg-[#F5F5F5] border border-[#141414] px-3 py-2 pr-9 text-[11px] font-mono focus:outline-none disabled:opacity-50"
              >
                {FALLBACK_MODE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none opacity-60" />
            </div>
          </div>
          <p className="mt-2 text-[10px] opacity-45 leading-relaxed">
            {fallbackHelperText}
          </p>
        </div>
      </section>

      <section className="bg-white border border-[#141414] p-6 shadow-[4px_4px_0px_0px_rgba(20,20,20,1)]">
        <div className="flex justify-between items-center mb-6">
          <h2 className="font-serif italic text-sm uppercase opacity-50">Evolutionary Metrics</h2>
          <div className="flex items-center gap-3">
            <AnimatePresence>
              {state.status !== 'idle' && state.status !== 'complete' && !showArtifacts && (
                <motion.div
                  initial={{ opacity: 0, x: 10 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 10 }}
                  className="flex items-center gap-2"
                >
                  <div className="flex items-center gap-1 bg-red-50 px-1.5 py-0.5 border border-red-200 rounded-sm">
                    <motion.div
                      animate={{ scale: [1, 1.5, 1], opacity: [1, 0.5, 1] }}
                      transition={{ repeat: Infinity, duration: 1.5 }}
                      className="w-1.5 h-1.5 bg-red-600 rounded-full"
                    />
                    <motion.span
                      animate={{ opacity: [1, 0, 1, 0.2, 1] }}
                      transition={{ repeat: Infinity, duration: 0.8, ease: 'linear' }}
                      className="text-[8px] font-black text-red-600 tracking-tighter"
                    >
                      LIVE
                    </motion.span>
                  </div>
                  <motion.span
                    animate={{ opacity: [0.6, 1, 0.6] }}
                    transition={{ repeat: Infinity, duration: 2 }}
                    className="text-[9px] uppercase font-bold tracking-tighter text-blue-600 hidden sm:inline"
                  >
                    Click [Show Artifacts] to monitor synthesis trace
                  </motion.span>
                </motion.div>
              )}
            </AnimatePresence>
            <button
              onClick={onToggleArtifacts}
              title={showArtifacts ? 'Close the technical artifacts panel' : 'View raw search results, evolutionary population, and assembly trace'}
              className={`text-[10px] uppercase font-bold flex items-center gap-1 px-2 py-1 border border-[#141414] transition-all ${showArtifacts ? 'bg-[#141414] text-white' : 'hover:bg-[#F5F5F5]'}`}
            >
              <Layers size={12} /> {showArtifacts ? 'Hide Artifacts' : 'Show Artifacts'}
            </button>
          </div>
        </div>

        <div className="space-y-6">
          <div className="flex justify-between items-end border-b border-[#141414] pb-2">
            <span className="text-[11px] uppercase font-bold">Status</span>
            <span className={`text-[11px] uppercase font-mono px-2 py-0.5 rounded-full ${state.status === 'complete' ? 'bg-green-100 text-green-800' : 'bg-blue-100 text-blue-800'}`}>
              {state.status}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="border border-[#141414] p-3 bg-[#F5F5F5]">
              <span className="block text-[9px] uppercase opacity-50 mb-1">Generation</span>
              <span className="text-2xl font-mono font-bold">{state.generation}</span>
              {evolutionWasSkipped && (
                <span className="block mt-1 text-[9px] leading-relaxed opacity-55">
                  Evolution rounds were skipped because the surviving evidence pool was too small to iterate.
                </span>
              )}
            </div>
            <div className="border border-[#141414] p-3 bg-[#F5F5F5]">
              <span className="block text-[9px] uppercase opacity-50 mb-1">Pop. Size</span>
              <span className="text-2xl font-mono font-bold">{state.population.length}</span>
            </div>
          </div>

          {state.status !== 'idle' && (
            <div className="space-y-2">
              <div className="flex justify-between text-[10px] uppercase font-bold">
                <span>Processing Pipeline</span>
                <span>{progressText}</span>
              </div>
              <div className="h-2 bg-[#F5F5F5] border border-[#141414] overflow-hidden">
                <motion.div
                  className="h-full bg-[#141414]"
                  initial={{ width: 0 }}
                  animate={{ width: progressWidthPct }}
                  transition={{ duration: 2, ease: 'easeInOut' }}
                />
              </div>
            </div>
          )}

          {notice && (
            <div className="bg-amber-50 border border-amber-200 p-3 text-amber-900 text-xs flex gap-2 items-start">
              <AlertCircle size={14} className="shrink-0 mt-0.5" />
              <span>{notice}</span>
            </div>
          )}

          {error && (
            <div className="bg-red-50 border border-red-200 p-3 text-red-800 text-xs flex gap-2 items-start">
              <AlertCircle size={14} className="shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1 max-h-40 overflow-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere] leading-relaxed">
                {error}
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="p-4 border border-[#141414] border-dashed bg-[#141414]/[0.02]">
        <h3 className="text-[10px] uppercase font-bold mb-3 flex items-center justify-between">
          <span className="flex items-center gap-2"><Dna size={12} /> Fitness Function F(w)</span>
          <span className="font-mono text-[9px] opacity-40">v2.5_EVO</span>
        </h3>
        <div className="space-y-3 font-mono text-[10px]">
          <div className="flex justify-between items-end border-b border-[#141414] pb-1">
            <span className="text-[11px] font-bold">F(w)</span>
            <div className="flex flex-col items-end">
              <span className="text-[8px] opacity-40 uppercase tracking-tighter">Current Best</span>
              <span className="text-[14px] font-bold leading-none">{state.bestFitness.toFixed(4)}</span>
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex justify-between items-center group">
              <div className="flex flex-col">
                <span className="opacity-60">alpha I(w)</span>
                <span className="text-[8px] opacity-40">Informative (NLP)</span>
              </div>
              <span className="font-medium">{(0.5 * (state.bestInformativeScore || 0)).toFixed(4)}</span>
            </div>

            <div className="flex justify-between items-center group">
              <div className="flex flex-col">
                <span className="opacity-60">beta A(w)</span>
                <span className="text-[8px] opacity-40">Authority (Topo)</span>
              </div>
              <span className="font-medium">{(0.3 * (state.bestAuthorityScore || 0)).toFixed(4)}</span>
            </div>

            <div className="flex justify-between items-center group">
              <div className="flex flex-col">
                <span className="opacity-60">gamma R(w,S)</span>
                <span className="text-[8px] opacity-40">Redundancy (Overlap)</span>
              </div>
              <span className="font-medium text-red-600">-{(0.2 * (state.bestRedundancyPenalty || 0)).toFixed(4)}</span>
            </div>
          </div>

          <div className="pt-2 border-t border-[#141414]/10 flex justify-between items-center">
            <span className="text-[8px] uppercase opacity-40">Algorithm Sequence</span>
            <div className="flex gap-1">
              <div className={`w-1.5 h-1.5 rounded-full ${state.status === 'searching' ? 'bg-blue-500 animate-pulse' : 'bg-[#141414]/20'}`} />
              <div className={`w-1.5 h-1.5 rounded-full ${state.status === 'evolving' ? 'bg-purple-500 animate-pulse' : 'bg-[#141414]/20'}`} />
              <div className={`w-1.5 h-1.5 rounded-full ${state.status === 'assembling' ? 'bg-green-500 animate-pulse' : 'bg-[#141414]/20'}`} />
            </div>
          </div>
        </div>
      </section>

      <AnimatePresence>
        {showArtifacts && (
          <motion.section
            ref={artifactsRef}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="bg-[#141414] text-[#E4E3E0] p-6 border border-[#141414] shadow-[4px_4px_0px_0px_rgba(20,20,20,0.5)] space-y-6 font-mono text-[10px]">
              <div className="flex items-center justify-between border-b border-white/10 pb-2">
                <h3 className="uppercase font-bold tracking-widest flex items-center gap-2">
                  <Cpu size={14} /> System Artifacts
                </h3>
                <button onClick={onToggleArtifacts} title="Close panel" className="hover:opacity-50">
                  <X size={14} />
                </button>
              </div>

              {searchSummary && (
                <div className="space-y-2">
                  <h4 className="text-amber-300 uppercase font-bold border-l-2 border-amber-300 pl-2">Search Coverage Summary</h4>
                  <div className="bg-white/5 p-3 border border-white/10 leading-relaxed text-[11px]">{searchSummary}</div>
                </div>
              )}

              <div className="space-y-2">
                <h4 className="text-blue-400 uppercase font-bold border-l-2 border-blue-400 pl-2">Raw Search Grounding</h4>
                {state.artifacts?.rawSearchResults && state.artifacts.rawSearchResults.length > 0 ? (
                  <div className="space-y-2 max-h-40 overflow-y-auto pr-2 custom-scrollbar">
                    {state.artifacts.rawSearchResults.map((chunk, index) => (
                      <div key={`${chunk.web?.uri || 'artifact'}-${index}`} className="bg-white/5 p-2 border border-white/10">
                        <div className="font-bold text-white truncate">{chunk.web?.title || 'Untitled Source'}</div>
                        <div className="opacity-50 truncate">{chunk.web?.uri}</div>
                        {chunk.snippet && <div className="mt-1 text-[9px] opacity-70 line-clamp-3">{chunk.snippet}</div>}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="opacity-30 italic">No search artifacts captured yet.</div>
                )}
              </div>

              <div className="space-y-2">
                <h4 className="text-green-400 uppercase font-bold border-l-2 border-green-400 pl-2">Evolved Population</h4>
                {state.artifacts?.evolvedPopulation && state.artifacts.evolvedPopulation.length > 0 ? (
                  <div className="space-y-2 max-h-40 overflow-y-auto pr-2 custom-scrollbar">
                    {state.artifacts.evolvedPopulation.map((genotype: WebPageGenotype, index: number) => (
                      <div key={`${genotype.id}-${index}`} className="bg-white/5 p-2 border border-white/10 flex justify-between items-center">
                        <div className="truncate flex-1 mr-4">
                          <div className="font-bold text-white truncate">{genotype.title}</div>
                          <div className="opacity-50 truncate text-[8px]">{genotype.url}</div>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="text-green-400 font-bold">{(genotype.fitness || 0).toFixed(4)}</div>
                          <div className="text-[8px] opacity-40">FITNESS</div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="opacity-30 italic">Evolution in progress...</div>
                )}
              </div>

              <div className="space-y-2">
                <h4 className="text-orange-400 uppercase font-bold border-l-2 border-orange-400 pl-2">Assembly Pipeline</h4>
                <div className="grid grid-cols-2 gap-2">
                  <div className="bg-white/5 p-2 border border-white/10">
                    <div className="opacity-50 mb-1">INPUT (TOP GENES)</div>
                    <div className="font-bold text-white">
                      {state.artifacts?.assemblyInput ? `${state.artifacts.assemblyInput.length} Sources` : 'Pending'}
                    </div>
                  </div>
                  <div className="bg-white/5 p-2 border border-white/10">
                    <div className="opacity-50 mb-1">OUTPUT (BOOK)</div>
                    <div className="font-bold text-white">
                      {state.artifacts?.assemblyOutput ? `${state.artifacts.assemblyOutput.chapters.length} Chapters` : 'Pending'}
                    </div>
                  </div>
                </div>
              </div>

              <div className="pt-2 text-[8px] opacity-30 italic text-center border-t border-white/10">
                Real-time trace of the evolutionary assembly process.
              </div>
            </div>
          </motion.section>
        )}
      </AnimatePresence>
    </div>
  );
}

