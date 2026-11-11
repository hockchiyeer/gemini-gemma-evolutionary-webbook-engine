import { CheckCircle2, ChevronRight, Loader2, TriangleAlert } from 'lucide-react';
import type { EvolutionState } from '../types';

export type LiveRunOutcome = 'complete' | 'failed' | null;

export function getLiveRunLabel(status: EvolutionState['status']): { label: string; pct: number } {
  switch (status) {
    case 'assembling':
      return { label: 'Assembling WebBook', pct: 80 };
    case 'evolving':
      return { label: 'Evolving source pages', pct: 55 };
    case 'parsing':
      return { label: 'Parsing sources', pct: 40 };
    default:
      return { label: 'Searching & extracting sources', pct: 25 };
  }
}

interface LiveRunBannerProps {
  status: EvolutionState['status'];
  topic: string;
  outcome: LiveRunOutcome;
  viewingTitle: string;
  onReturn: () => void;
}

export function LiveRunBanner({ status, topic, outcome, viewingTitle, onReturn }: LiveRunBannerProps) {
  const { label, pct } = getLiveRunLabel(status);
  const tone =
    outcome === 'complete'
      ? 'bg-green-50 border-green-700'
      : outcome === 'failed'
        ? 'bg-red-50 border-red-600'
        : 'bg-white border-[#141414]';

  return (
    <div
      role="status"
      aria-live="polite"
      data-html2canvas-ignore="true"
      className={`lg:col-span-12 sticky top-2 z-40 border ${tone} shadow-[4px_4px_0px_0px_rgba(20,20,20,1)] print:hidden`}
    >
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 px-4 py-3">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          {outcome === 'complete' ? (
            <CheckCircle2 size={18} className="text-green-700 shrink-0" />
          ) : outcome === 'failed' ? (
            <TriangleAlert size={18} className="text-red-600 shrink-0" />
          ) : (
            <Loader2 size={18} className="animate-spin shrink-0" />
          )}
          <div className="min-w-0">
            <p className="text-[11px] font-bold uppercase tracking-wider truncate">
              {outcome === 'complete'
                ? `New WebBook ready: ${topic}`
                : outcome === 'failed'
                  ? `Generation failed: ${topic}`
                  : `Generating in background: ${topic}`}
            </p>
            <p className="text-[10px] opacity-60 truncate">
              {outcome ? 'Still viewing' : `${label} (${pct}%) · currently viewing`}
              {': '}
              {viewingTitle}
            </p>
          </div>
        </div>
        <button
          onClick={onReturn}
          className="shrink-0 px-4 py-2 bg-[#141414] text-[#E4E3E0] text-[10px] uppercase font-bold tracking-widest flex items-center justify-center gap-1 hover:bg-opacity-90 transition-all active:scale-95"
        >
          {outcome === 'complete' ? 'View new WebBook' : outcome === 'failed' ? 'See details' : 'Back to live generation'}
          <ChevronRight size={12} />
        </button>
      </div>
      {!outcome && (
        <div className="h-1 bg-[#141414]/10">
          <div className="h-full bg-[#141414] transition-all duration-700" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}
