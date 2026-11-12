import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronRight, Clock, History, Loader2, Trash2, X } from 'lucide-react';
import type { WebBook } from '../types';

interface HistoryDrawerProps {
  showHistory: boolean;
  history: WebBook[];
  onClose: () => void;
  onView: (item: WebBook) => void;
  onDelete: (id: string) => void;
  onClearAll: () => void;
  viewingId?: string | null;
  liveRun?: { topic: string; statusLabel: string; outcome: 'complete' | 'failed' | null } | null;
  isViewingLive?: boolean;
  onViewLive?: () => void;
}

export function HistoryDrawer({
  showHistory,
  history,
  onClose,
  onView,
  onDelete,
  onClearAll,
  viewingId = null,
  liveRun = null,
  isViewingLive = true,
  onViewLive,
}: HistoryDrawerProps) {
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmClearAll, setConfirmClearAll] = useState(false);

  return (
    <AnimatePresence>
      {showHistory && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-[#141414]/40 backdrop-blur-sm z-[100]"
            data-html2canvas-ignore="true"
          />
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            className="fixed right-0 top-0 bottom-0 w-full max-w-md bg-[#E4E3E0] border-l border-[#141414] z-[101] shadow-2xl flex flex-col"
            data-html2canvas-ignore="true"
          >
            <div className="p-6 border-b border-[#141414] flex justify-between items-center bg-white">
              <h2 className="text-lg font-serif italic font-bold flex items-center gap-2">
                <History size={20} /> Archive & History
              </h2>
              <button onClick={onClose} title="Close history" className="p-2 hover:bg-[#F5F5F5] rounded-full transition-colors">
                <X size={20} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              {liveRun && (
                <button
                  type="button"
                  onClick={onViewLive}
                  title="Click to return to main page with webbook in progress"
                  className="w-full text-left bg-[#141414] text-[#E4E3E0] border border-[#141414] p-4 shadow-[4px_4px_0px_0px_rgba(20,20,20,0.35)] cursor-pointer hover:bg-[#222222] hover:translate-x-0.5 hover:translate-y-0.5 active:translate-x-1 active:translate-y-1 transition-all group relative select-none block"
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2 text-[9px] uppercase font-mono tracking-wider opacity-80">
                      {!liveRun.outcome && <Loader2 size={12} className="animate-spin text-blue-400" />}
                      {liveRun.outcome ? (liveRun.outcome === 'complete' ? 'Latest generation ready' : 'Latest generation failed') : 'Generation in progress'}
                    </div>
                    {isViewingLive ? (
                      <span className="text-[9px] font-mono bg-white/15 px-1.5 py-0.5 rounded text-white font-semibold uppercase tracking-wider">
                        Active
                      </span>
                    ) : (
                      <span className="text-[9px] font-mono bg-blue-500/20 text-blue-300 border border-blue-500/40 px-1.5 py-0.5 rounded font-semibold uppercase tracking-wider">
                        In Background
                      </span>
                    )}
                  </div>
                  <h3 className="font-serif italic font-bold text-lg leading-tight mb-1 text-white group-hover:text-white transition-colors">{liveRun.topic}</h3>
                  <p className="text-[10px] uppercase tracking-wider opacity-70 mb-3">{liveRun.statusLabel}</p>
                  <div className="flex items-center justify-between pt-2 border-t border-white/15">
                    <span className="text-[10px] uppercase font-bold flex items-center gap-1 group-hover:underline text-white">
                      {isViewingLive ? 'Return to webbook in progress' : liveRun.outcome === 'complete' ? 'View new book' : 'Switch to webbook in progress'}
                    </span>
                    <ChevronRight size={14} className="group-hover:translate-x-1 transition-transform text-white shrink-0" />
                  </div>
                </button>
              )}
              {history.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center opacity-30 text-center">
                  <Clock size={48} />
                  <p className="mt-4 font-serif italic">No archived Web-books found</p>
                </div>
              ) : (
                history.map((item) => (
                  <div
                    key={item.id}
                    className={`${viewingId === item.id ? 'bg-[#F5F5F5] ring-2 ring-[#141414]' : 'bg-white'} border border-[#141414] p-4 shadow-[4px_4px_0px_0px_rgba(20,20,20,1)] hover:translate-x-1 hover:translate-y-1 hover:shadow-none transition-all group relative`}
                  >
                    <div className="flex justify-between items-start mb-2">
                      <span className="text-[9px] uppercase font-mono opacity-50">
                        {new Date(item.timestamp).toLocaleDateString()} - {new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                      {confirmDeleteId === item.id ? (
                        <div className="flex items-center gap-2">
                          <button
                            onClick={(event) => {
                              event.stopPropagation();
                              onDelete(item.id);
                              setConfirmDeleteId(null);
                            }}
                            className="text-[9px] uppercase font-bold text-red-600 hover:underline"
                          >
                            Confirm
                          </button>
                          <button
                            onClick={(event) => {
                              event.stopPropagation();
                              setConfirmDeleteId(null);
                            }}
                            className="text-[9px] uppercase font-bold opacity-60 hover:underline"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={(event) => {
                            event.stopPropagation();
                            setConfirmDeleteId(item.id);
                          }}
                          title="Delete this book from history"
                          className="text-red-600 opacity-0 group-hover:opacity-100 transition-opacity p-1 hover:bg-red-50 rounded"
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                    <h3 className="font-serif italic font-bold text-lg leading-tight mb-3">{item.topic}</h3>
                    <div className="flex justify-between items-center gap-3">
                      <span className="text-[10px] uppercase font-bold opacity-60">{viewingId === item.id ? 'Viewing now' : `${item.chapters.length} Chapters`}</span>
                      <button
                        onClick={() => onView(item)}
                        title="Load this archived Web-book into the viewer"
                        className="text-[10px] uppercase font-bold flex items-center gap-1 hover:underline"
                      >
                        View Book <ChevronRight size={12} />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>

            {history.length > 0 && (
              <div className="p-6 border-t border-[#141414] bg-white">
                {confirmClearAll ? (
                  <div className="w-full flex gap-2">
                    <button
                      onClick={() => {
                        onClearAll();
                        setConfirmClearAll(false);
                      }}
                      className="flex-1 py-3 bg-red-600 text-white text-[11px] uppercase font-bold tracking-widest hover:bg-red-700 transition-all"
                    >
                      Confirm Delete All
                    </button>
                    <button
                      onClick={() => setConfirmClearAll(false)}
                      className="flex-1 py-3 border border-[#141414] text-[#141414] text-[11px] uppercase font-bold tracking-widest hover:bg-[#F5F5F5] transition-all"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmClearAll(true)}
                    title="Permanently delete all archived Web-books"
                    className="w-full py-3 border border-red-600 text-red-600 text-[11px] uppercase font-bold tracking-widest hover:bg-red-600 hover:text-white transition-all"
                  >
                    Clear All History
                  </button>
                )}
              </div>
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
