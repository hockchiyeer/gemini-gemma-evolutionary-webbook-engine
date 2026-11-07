import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  ChevronDown,
  Dna,
  Download,
  FileCode,
  FileText,
  History,
  Image as ImageIcon,
  Loader2,
  Printer,
} from 'lucide-react';
import type { WebBook } from '../types';

interface AppHeaderProps {
  webBook: WebBook | null;
  isBusy: boolean;
  isExporting: boolean;
  onNewSearch: () => void;
  onToggleHistory: () => void;
  onExportPdf: () => Promise<void>;
  onExportPrint: () => Promise<void>;
  onExportPrintFriendlyPdf: () => Promise<void>;
  onExportPrintFriendlyImage: () => Promise<void>;
  onExportWord: () => Promise<void>;
  onExportHtml: () => Promise<void>;
  onExportTxt: () => Promise<void>;
}

export function AppHeader({
  webBook,
  isBusy,
  isExporting,
  onNewSearch,
  onToggleHistory,
  onExportPdf,
  onExportPrint,
  onExportPrintFriendlyPdf,
  onExportPrintFriendlyImage,
  onExportWord,
  onExportHtml,
  onExportTxt,
}: AppHeaderProps) {
  const [showExportOptions, setShowExportOptions] = useState(false);
  const exportDropdownRef = useRef<HTMLDivElement>(null);



  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (exportDropdownRef.current && !exportDropdownRef.current.contains(event.target as Node)) {
        setShowExportOptions(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const runExport = async (action: () => Promise<void>) => {
    setShowExportOptions(false);
    await action();
  };

  return (
    <header
      data-html2canvas-ignore="true"
      className="border-b border-[#141414] p-4 md:p-6 flex flex-col md:flex-row justify-between items-center gap-4 bg-[#E4E3E0] sticky top-0 z-50 print:hidden"
    >
      <div className="flex items-center gap-3 w-full md:w-auto">
        <div className="w-10 h-10 bg-[#141414] flex items-center justify-center rounded-sm shrink-0">
          <Dna className="text-[#E4E3E0] w-6 h-6" />
        </div>
        <div className="overflow-hidden">
          <h1 className="text-lg md:text-xl font-bold tracking-tighter uppercase italic font-serif truncate">Evolutionary Web-Book Engine</h1>
          <p className="text-[9px] md:text-[10px] uppercase tracking-widest opacity-60 truncate">Mitigating Search Redundancy via Evolutionary Computing</p>
        </div>
      </div>

      <div className="flex items-center gap-2 md:gap-6 w-full md:w-auto justify-between md:justify-end">
        {webBook && (
          <div className="hidden xl:flex items-center gap-3 border-x border-[#141414]/10 px-6 mx-2 h-10">
            <span className="text-[10px] font-bold uppercase tracking-widest opacity-40">Jump:</span>
            <div className="flex gap-1.5">
              {webBook.chapters.map((chapter, index) => (
                <a
                  key={chapter.title + index}
                  href={`#chapter-${index}`}
                  target="_self"
                  className="w-7 h-7 flex items-center justify-center font-mono text-[10px] border border-[#141414]/10 hover:bg-[#141414] hover:text-white transition-all"
                  title={`Jump to Chapter ${index + 1}: ${chapter.title}`}
                >
                  {index + 1}
                </a>
              ))}
            </div>
          </div>
        )}

        <div className="flex items-center gap-2 md:gap-4">
          {webBook && (
            <div className="flex items-center gap-2 md:gap-3 border-r border-[#141414]/10 pr-2 md:pr-4 mr-2 md:mr-4">
              <button
                onClick={onNewSearch}
                disabled={isBusy}
                title="Clear current book and start a new evolutionary search"
                className="px-3 md:px-4 py-2 border border-[#141414] text-[9px] md:text-[10px] uppercase font-bold tracking-widest hover:bg-[#141414] hover:text-white transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-inherit"
              >
                New Search
              </button>

              <div className="relative" ref={exportDropdownRef}>
                <button
                  onClick={() => setShowExportOptions((previousState) => !previousState)}
                  aria-expanded={showExportOptions}
                  aria-haspopup="true"
                  disabled={isExporting}
                  title="Download or print this Web-book in various formats"
                  className="px-3 md:px-4 py-2 bg-[#141414] text-[#E4E3E0] text-[9px] md:text-[10px] uppercase font-bold tracking-widest hover:bg-opacity-90 transition-all flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isExporting ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <>
                      <Download size={12} />
                      <span className="hidden sm:inline">Export</span>
                      <ChevronDown size={12} className={`transition-transform ${showExportOptions ? 'rotate-180' : ''}`} />
                    </>
                  )}
                </button>

                <AnimatePresence>
                  {showExportOptions && (
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 10 }}
                      className="absolute top-full left-0 right-auto md:left-auto md:right-0 mt-2 w-56 bg-white border border-[#141414] shadow-2xl z-50 overflow-hidden print:hidden"
                    >
                      <button
                        onClick={() => void runExport(onExportPdf)}
                        title="Generate a high-quality PDF with images and styling"
                        className="w-full px-4 py-3 text-left text-[10px] uppercase font-bold hover:bg-[#F5F5F5] flex items-center gap-3 border-b border-[#141414]/10"
                      >
                        <FileText size={14} className="text-red-600" /> PDF Document (High Res)
                      </button>
                      <button
                        onClick={() => void runExport(onExportPrint)}
                        title="Open system print dialog (recommended for large books)"
                        className="w-full px-4 py-3 text-left text-[10px] uppercase font-bold hover:bg-[#F5F5F5] flex items-center gap-3 border-b border-[#141414]/10"
                      >
                        <Printer size={14} className="text-green-600" /> Print / Save as PDF
                      </button>
                      <button
                        onClick={() => void runExport(onExportPrintFriendlyPdf)}
                        title="Export A4 size print-friendly full-text report as PDF"
                        className="w-full px-4 py-3 text-left text-[10px] uppercase font-bold hover:bg-[#F5F5F5] flex items-center gap-3 border-b border-[#141414]/10"
                      >
                        <FileText size={14} className="text-emerald-600" /> Print Friendly PDF
                      </button>
                      <button
                        onClick={() => void runExport(onExportPrintFriendlyImage)}
                        title="Export A4 size print-friendly full-text report as JPG image"
                        className="w-full px-4 py-3 text-left text-[10px] uppercase font-bold hover:bg-[#F5F5F5] flex items-center gap-3 border-b border-[#141414]/10"
                      >
                        <ImageIcon size={14} className="text-purple-600" /> Print Friendly Image (JPG)
                      </button>
                      <button
                        onClick={() => void runExport(onExportWord)}
                        title="Export as Microsoft Word document for editing"
                        className="w-full px-4 py-3 text-left text-[10px] uppercase font-bold hover:bg-[#F5F5F5] flex items-center gap-3 border-b border-[#141414]/10"
                      >
                        <FileText size={14} className="text-blue-600" /> Word (.docx)
                      </button>
                      <button
                        onClick={() => void runExport(onExportHtml)}
                        title="Download as a standalone HTML file"
                        className="w-full px-4 py-3 text-left text-[10px] uppercase font-bold hover:bg-[#F5F5F5] flex items-center gap-3 border-b border-[#141414]/10"
                      >
                        <FileCode size={14} className="text-orange-600" /> HTML Webpage
                      </button>
                      <button
                        onClick={() => void runExport(onExportTxt)}
                        title="Export as a simple text file without formatting"
                        className="w-full px-4 py-3 text-left text-[10px] uppercase font-bold hover:bg-[#F5F5F5] flex items-center gap-3"
                      >
                        <FileText size={14} className="text-gray-600" /> Plain Text
                      </button>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
          )}

          <button
            onClick={onToggleHistory}
            title="View and manage previously generated Web-books"
            className="flex items-center gap-2 text-[10px] md:text-[11px] uppercase tracking-wider font-bold hover:opacity-70 transition-opacity"
          >
            <History size={14} /> <span className="hidden sm:inline">History</span>
          </button>
        </div>
      </div>
    </header>
  );
}
