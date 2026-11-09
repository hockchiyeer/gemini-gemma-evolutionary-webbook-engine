import React from 'react';
import { ArrowUpRight, BookOpen, CheckCircle2, Globe2, Image as ImageIcon, Layers } from 'lucide-react';
import type { WebBook } from './types';
import { isSnippetOnlySourceMode } from './types';
import { getExportLabels, type ExportLabels } from './services/exportLabels';
import { summarizeTitle } from './services/documentTitle';
import { buildChapterRenderPlan, getChapterSourceLinks, hasRealVisualCaption, normalizeSourceLink, sanitizeWebBookForPresentation } from './utils/webBookRender';

interface WebBookViewerProps {
  webBook: WebBook;
}

function getParagraphs(content: string): string[] {
  return content
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

// Snippet-only books have no analysis/synthesis structure, so they get no scripted section labels.
function getNarrativeLabel(pageIndex: number, L: ExportLabels, snippetOnly: boolean): string {
  if (snippetOnly) return '';
  if (pageIndex === 0) return L.overview;
  if (pageIndex === 1) return L.evidenceContext;
  return L.synthesisImplications;
}

export function WebBookViewer({ webBook }: WebBookViewerProps) {
  const safeWebBook = sanitizeWebBookForPresentation(webBook);
  const L = getExportLabels(safeWebBook);
  const safeChapters = Array.isArray(safeWebBook?.chapters) ? safeWebBook.chapters : [];
  const snippetOnly = isSnippetOnlySourceMode(safeWebBook?.sourceMode);
  const chapterRenderPlan = buildChapterRenderPlan(safeChapters, { sourceMode: safeWebBook?.sourceMode });
  const finalDocumentPageNumber = chapterRenderPlan.length > 0
    ? chapterRenderPlan[chapterRenderPlan.length - 1].glossaryPageNumber + 1
    : 3;

  return (
    <div className="web-book-container w-full max-w-[900px] space-y-8 overflow-x-hidden print:max-w-none print:space-y-0 print:block print:overflow-visible" id="top">
      <section id="page-1" data-pdf-page-number="1" data-pdf-page-kind="cover" className="web-book-page bg-[#141414] text-[#E4E3E0] p-16 relative overflow-hidden text-center min-h-[1000px] md:min-h-[1123px] flex flex-col justify-center border border-[#141414] shadow-[12px_12px_0px_0px_rgba(20,20,20,0.18)] print:shadow-none print:border-none print:block print:min-h-0 print:h-auto print:page-break-after-always">
        <div className="relative z-10">
          <div className="flex flex-col items-center gap-4 mb-8">
            <div className="w-12 h-12 border-2 border-[#E4E3E0] flex items-center justify-center rotate-45">
              <Layers size={24} className="-rotate-45" />
            </div>
            <span className="text-[10px] uppercase tracking-[0.5em] opacity-60">{L.engineName}</span>
          </div>
          <h2 className="text-5xl md:text-7xl font-serif italic font-bold tracking-tighter leading-tight mb-8 break-words">{summarizeTitle(safeWebBook.topic)}</h2>
          <div className="w-24 h-1 bg-[#E4E3E0] mx-auto mb-12 opacity-30" />
          <div className="flex justify-center gap-16">
            <div className="flex flex-col">
              <span className="text-[9px] uppercase opacity-50 mb-2 tracking-widest">{L.chapters}</span>
              <span className="text-3xl font-mono">{safeChapters.length}</span>
            </div>
            <div className="flex flex-col">
              <span className="text-[9px] uppercase opacity-50 mb-2 tracking-widest">{L.concepts}</span>
              <span className="text-3xl font-mono">{safeChapters.reduce((accumulator, chapter) => accumulator + (Array.isArray(chapter.definitions) ? chapter.definitions.length : 0), 0)}</span>
            </div>
            <div className="flex flex-col">
              <span className="text-[9px] uppercase opacity-50 mb-2 tracking-widest">{L.date}</span>
              <span className="text-3xl font-mono">{new Date(safeWebBook.timestamp).toLocaleDateString(L.dateLocale, { month: 'short', year: 'numeric' })}</span>
            </div>
          </div>
        </div>
        <div className="absolute top-0 left-0 w-full h-full opacity-10 pointer-events-none">
          <div className="absolute top-10 left-10 w-80 h-80 border border-white rounded-full" />
          <div className="absolute bottom-10 right-10 w-96 h-96 border border-white rounded-full" />
        </div>
        <div className="absolute bottom-12 left-1/2 -translate-x-1/2 text-[10px] font-mono opacity-40 print:hidden">{L.upper(L.pageShort(1))}</div>
      </section>

      <section id="page-2" data-pdf-page-number="2" data-pdf-page-kind="toc" className="web-book-page p-12 md:p-20 bg-[#FAFAFA] min-h-[1000px] md:min-h-[1123px] flex flex-col relative border border-[#141414] shadow-[12px_12px_0px_0px_rgba(20,20,20,0.12)] print:shadow-none print:border-none print:block print:min-h-0 print:h-auto print:page-break-after-always">
        <h3 className="text-[14px] uppercase font-bold mb-16 tracking-[0.3em] border-b-2 border-[#141414] pb-6 inline-block self-start">{L.tableOfContents}</h3>
        <div className="space-y-8 flex-1 print:space-y-0">
          {chapterRenderPlan.map(({ chapter, titlePageNumber }, index) => (
            <a key={chapter.title + index} href={`#chapter-${index}`} target="_self" data-pdf-target-page={titlePageNumber} title={L.navigateTo(index + 1)} className="flex items-end gap-4 md:gap-6 group">
              <span className="font-mono text-base opacity-40">{String(index + 1).padStart(2, '0')}</span>
              <span className="text-lg md:text-xl font-medium group-hover:underline underline-offset-8 decoration-1 break-words">{chapter.title}</span>
              <div className="flex-1 border-b border-dotted border-[#141414] opacity-20 mb-2" />
              <span className="font-mono text-base opacity-40">{L.locale === 'en' ? `P.${titlePageNumber}` : L.pageRef(titlePageNumber)}</span>
            </a>
          ))}
        </div>
        <div className="mt-auto pt-12 flex justify-center text-[10px] font-mono opacity-40 print:hidden">{L.upper(L.pageShort(2))}</div>
      </section>

      <div data-pdf-page-stack="chapters" className="space-y-8 print:space-y-0 print:block">
        {chapterRenderPlan.map(({ chapter, titlePageNumber, textPages, glossaryPageNumber, renderableDefinitions, renderableSubTopics }, index) => {
          const sourceLinks = getChapterSourceLinks(chapter, { maxItems: 8 });
          const externalSourceLinks = getChapterSourceLinks(chapter, { includeSearchResults: false, maxItems: 6 });
          const displayedSourceLinks = externalSourceLinks.length > 0 ? externalSourceLinks : sourceLinks;
          const readingTrailLinks = displayedSourceLinks.slice(0, 5);
          const verificationSource = displayedSourceLinks.find(
            (candidate) => !readingTrailLinks.some((sourceLink) => sourceLink.url === candidate.url)
          ) || readingTrailLinks[0] || null;
          const surfacedSourceUrls = new Set(readingTrailLinks.map((sourceLink) => sourceLink.url));
          if (verificationSource) {
            surfacedSourceUrls.add(verificationSource.url);
          }
          const auxiliarySourceUrls = new Set<string>();
          const claimAuxiliarySourceUrl = (sourceUrl?: string) => {
            const normalized = sourceUrl ? normalizeSourceLink({ title: sourceUrl, url: sourceUrl }) : null;
            if (!normalized || normalized.isSearchResultsPage) {
              return null;
            }
            if (surfacedSourceUrls.has(normalized.url) || auxiliarySourceUrls.has(normalized.url)) {
              return null;
            }

            auxiliarySourceUrls.add(normalized.url);
            return normalized.url;
          };
          const hostnames = Array.from(new Set(displayedSourceLinks.map((sourceLink) => sourceLink.hostname))).slice(0, 6);
          const glossaryDefinitions = renderableDefinitions.slice(0, 6);
          const synthesisSubTopics = renderableSubTopics.slice(0, 3);

          return (
            <React.Fragment key={chapter.title + titlePageNumber}>
              {textPages.map((textPage, pageIndex) => {
                const paragraphs = getParagraphs(textPage.content);
                const compactSources = displayedSourceLinks.slice(pageIndex * 2, pageIndex * 2 + 2);
                const isOpeningPage = pageIndex === 0;
                const isFinalNarrativePage = pageIndex === textPages.length - 1;

                return (
                  <section
                    key={`${chapter.title}-${textPage.pageNumber}`}
                    id={`page-${textPage.pageNumber}`}
                    data-pdf-page-number={String(textPage.pageNumber)}
                    data-pdf-page-kind={isOpeningPage ? 'chapter' : 'chapter-continuation'}
                    className="web-book-page p-10 md:p-16 bg-white border border-[#141414] shadow-[12px_12px_0px_0px_rgba(20,20,20,0.12)] min-h-[1000px] md:min-h-[1123px] flex flex-col relative print:shadow-none print:border-none print:block print:min-h-0 print:h-auto print:page-break-after-always"
                  >
                    {isOpeningPage ? (
                      <>
                        <div id={`chapter-${index}`} className="flex items-center justify-between gap-4 mb-12 border-b border-[#141414]/10 pb-6">
                          <div className="flex items-center gap-4 min-w-0">
                            <span className="w-10 h-10 bg-[#141414] text-white flex items-center justify-center font-mono text-sm">{String(index + 1).padStart(2, '0')}</span>
                            <h3 className="text-3xl md:text-4xl font-serif italic font-bold tracking-tight break-words">{chapter.title}</h3>
                          </div>
                          <div className="text-[10px] uppercase font-bold opacity-30 tracking-widest">{L.chapterSlash(index + 1, chapterRenderPlan.length)}</div>
                        </div>

                        <div className="mb-10 relative group">
                          <div className="aspect-[16/9] w-full overflow-hidden border border-[#141414] bg-[#F5F5F5] shadow-inner">
                            <img
                              src={`https://picsum.photos/seed/${chapter.visualSeed || chapter.title}/1200/800`}
                              alt={chapter.title}
                              referrerPolicy="no-referrer"
                              crossOrigin="anonymous"
                              className="w-full h-full object-cover grayscale hover:grayscale-0 transition-all duration-1000 scale-105 group-hover:scale-100"
                            />
                          </div>
                          {hasRealVisualCaption(chapter) && (
                            <div className="absolute -bottom-4 right-8 max-w-[75%] bg-white border border-[#141414] px-4 py-2 text-[10px] uppercase font-bold tracking-widest flex items-center gap-3 shadow-md break-words">
                              <ImageIcon size={12} /> {chapter.visualSeed}
                            </div>
                          )}
                        </div>
                      </>
                    ) : (
                      <div className="mb-8 flex items-center justify-between gap-4 border-b border-[#141414]/10 pb-5">
                        <div className="min-w-0">
                          {getNarrativeLabel(pageIndex, L, snippetOnly) && <div className="text-[10px] uppercase tracking-[0.28em] font-bold text-[#141414]/45 mb-3">{getNarrativeLabel(pageIndex, L, snippetOnly)}</div>}
                          <h4 className="text-2xl md:text-3xl font-serif italic font-bold break-words">{chapter.title}</h4>
                        </div>
                        <div className="text-[10px] uppercase font-bold tracking-widest opacity-35">{L.continuation}</div>
                      </div>
                    )}

                    <div className="flex-1 flex flex-col gap-8">
                      {isOpeningPage && hostnames.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                          {hostnames.map((hostname) => (
                            <span key={hostname} className="px-3 py-1 border border-[#141414]/15 bg-[#F7F4EE] text-[10px] uppercase font-bold tracking-[0.18em] text-[#141414]/65">
                              {hostname}
                            </span>
                          ))}
                        </div>
                      )}

                      <div className="space-y-6">
                        {paragraphs.map((paragraph, paragraphIndex) => (
                          <p
                            key={`${textPage.pageNumber}-${paragraphIndex}`}
                            className={isOpeningPage && paragraphIndex === 0
                              ? 'text-xl leading-relaxed text-gray-800 font-light first-letter:text-6xl first-letter:font-serif first-letter:mr-3 first-letter:float-left first-letter:leading-none'
                              : 'text-[17px] leading-relaxed text-gray-700 font-light'}
                          >
                            {paragraph}
                          </p>
                        ))}
                      </div>

                      {pageIndex === 1 && compactSources.length > 0 && (
                        <div className="border border-[#141414] bg-[#F7F4EE] p-5 print:break-inside-avoid">
                          <div className="text-[10px] uppercase font-bold tracking-[0.24em] text-[#141414]/60 mb-4 flex items-center gap-2">
                            <Globe2 size={12} /> Comparative Source Trail
                          </div>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {compactSources.map((sourceLink, sourceIndex) => (
                              <a
                                key={sourceLink.url + sourceIndex}
                                href={sourceLink.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="border border-[#141414] bg-white px-4 py-4 hover:bg-[#141414] hover:text-white transition-colors group"
                                title={L.tipOpenArticle}
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0">
                                    <div className="font-semibold text-sm uppercase tracking-wide break-words">{sourceLink.title}</div>
                                    <div className="text-[11px] opacity-60 mt-2 break-all">{sourceLink.hostname}</div>
                                  </div>
                                  <ArrowUpRight size={16} className="shrink-0 mt-0.5 opacity-70 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
                                </div>
                              </a>
                            ))}
                          </div>
                        </div>
                      )}

                      {isFinalNarrativePage && synthesisSubTopics.length > 0 && (
                        <div className="space-y-5">
                          <div className="text-[10px] uppercase font-bold tracking-[0.28em] text-[#141414]/60 border-t border-[#141414]/10 pt-6">
                            {L.deeperAnglesShort}
                          </div>
                          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                            {synthesisSubTopics.map((subTopic, subTopicIndex) => {
                              const subTopicSourceUrl = claimAuxiliarySourceUrl(subTopic.sourceUrl);

                              return (
                                <div key={subTopic.title + subTopicIndex} className="border border-[#141414] bg-[#FBFBFB] p-5 flex flex-col gap-3 print:break-inside-avoid">
                                  <h5 className="font-bold text-lg leading-tight">{subTopic.title}</h5>
                                  <p className="text-sm leading-relaxed text-gray-600 font-light">{subTopic.summary}</p>
                                  {subTopicSourceUrl && (
                                    <a
                                      href={subTopicSourceUrl}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="inline-flex items-center gap-2 mt-auto text-[11px] uppercase tracking-[0.18em] font-bold text-[#141414] hover:underline"
                                      title={L.tipOpenAngle}
                                    >
                                      {L.sourceArticle} <ArrowUpRight size={12} />
                                    </a>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="mt-auto pt-10 flex justify-between items-center border-t border-[#141414]/5 text-[10px] font-mono opacity-40 print:hidden">
                      <span className="break-words">{safeWebBook.topic}</span>
                      <span>{L.upper(L.pageShort(textPage.pageNumber))}</span>
                    </div>
                  </section>
                );
              })}

              <section
                id={`page-${glossaryPageNumber}`}
                data-pdf-page-number={String(glossaryPageNumber)}
                data-pdf-page-kind="glossary"
                className="web-book-page p-10 md:p-16 bg-white border border-[#141414] shadow-[12px_12px_0px_0px_rgba(20,20,20,0.12)] min-h-[1000px] md:min-h-[1123px] flex flex-col relative print:shadow-none print:border-none print:block print:min-h-0 print:h-auto print:page-break-after-always"
              >
                <div className="flex items-center justify-between gap-4 mb-10 border-b border-[#141414]/10 pb-5">
                  <div className="min-w-0">
                    <div className="text-[10px] uppercase tracking-[0.28em] font-bold text-[#141414]/45 mb-3">
                      {glossaryDefinitions.length > 0 ? L.technicalGlossary : L.referenceAndSources}
                    </div>
                    <h4 className="text-2xl md:text-3xl font-serif italic font-bold break-words">{chapter.title}</h4>
                  </div>
                  <div className="text-[10px] uppercase font-bold tracking-widest opacity-35">{L.referencePage}</div>
                </div>

                {glossaryDefinitions.length > 0 ? (
                  <div className="flex-1 grid grid-cols-1 lg:grid-cols-[1.55fr_0.9fr] gap-8">
                    <div className="bg-[#141414] text-white p-8 shadow-xl">
                      <h4 className="text-[10px] uppercase font-bold tracking-[0.3em] mb-8 flex items-center gap-3 opacity-70 border-b border-white/10 pb-5">
                        <BookOpen size={16} /> {L.coreTerms}
                      </h4>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-8">
                        {glossaryDefinitions.map((definition, definitionIndex) => {
                          const words = (definition.description || '').split(/\s+/);
                          const isLong = words.length > 55;
                          const displayDescription = isLong ? `${words.slice(0, 55).join(' ')}...` : definition.description;
                          const definitionSourceUrl = claimAuxiliarySourceUrl(definition.sourceUrl);

                          return (
                            <div key={definition.term + definitionIndex} className="group print:break-inside-avoid">
                              <span className="font-mono text-[12px] font-bold block mb-3 uppercase text-blue-400 tracking-wider break-words">
                                {definition.term}
                              </span>
                              <p className="text-sm leading-relaxed opacity-85 font-light italic border-l border-white/10 pl-4 break-words">
                                {displayDescription}
                              </p>
                              {definitionSourceUrl && (
                                <a
                                  href={definitionSourceUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  title={L.tipReadTerm}
                                  className="inline-flex items-center gap-2 mt-4 text-[11px] uppercase tracking-[0.2em] font-bold text-blue-400 hover:underline"
                                >
                                  {L.sourceArticle} <ArrowUpRight size={12} />
                                </a>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    <div className="space-y-6">
                      <div className="border border-[#141414] bg-[#F7F4EE] p-6">
                        <div className="text-[10px] uppercase font-bold tracking-[0.24em] text-[#141414]/60 mb-4 flex items-center gap-2">
                          <Globe2 size={12} /> {L.readingTrail}
                        </div>
                        <div className="space-y-4">
                          {readingTrailLinks.map((sourceLink, sourceIndex) => (
                            <a
                              key={sourceLink.url + sourceIndex}
                              href={sourceLink.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="block border border-[#141414] bg-white px-4 py-4 hover:bg-[#141414] hover:text-white transition-colors group"
                              title={L.tipOpenArticle}
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <div className="font-semibold text-sm uppercase tracking-wide break-words">{sourceLink.title}</div>
                                  <div className="text-[11px] opacity-60 mt-2 break-all">{sourceLink.hostname}</div>
                                </div>
                                <ArrowUpRight size={16} className="shrink-0 mt-0.5 opacity-70 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
                              </div>
                            </a>
                          ))}
                        </div>
                      </div>

                      {verificationSource && !readingTrailLinks.some((sourceLink) => sourceLink.url === verificationSource.url) && (
                      <div className="border border-[#141414]/10 p-6 bg-white">
                        <div className="text-[10px] uppercase font-bold tracking-[0.24em] text-[#141414]/60 mb-4">{L.sourceVerification}</div>
                        <div className="text-sm leading-relaxed text-gray-600 font-light">
                          {verificationSource ? (
                            readingTrailLinks.some((sourceLink) => sourceLink.url === verificationSource.url) ? (
                              <span className="font-semibold text-[#141414] break-words">
                                {verificationSource.title}
                              </span>
                            ) : (
                              <a
                                href={verificationSource.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                title={L.tipVerifyChapter}
                                className="inline-flex items-center gap-2 font-semibold text-[#141414] hover:underline break-all"
                              >
                                {verificationSource.title} <ArrowUpRight size={14} />
                              </a>
                            )
                          ) : (
                            L.noSupportingSource
                          )}
                        </div>
                      </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-8 items-start">
                    <div className="border border-[#141414] bg-[#F7F4EE] p-6 shadow-sm">
                      <div className="text-[10px] uppercase font-bold tracking-[0.24em] text-[#141414]/60 mb-4 flex items-center gap-2">
                        <Globe2 size={14} /> Credible Reading Trail
                      </div>
                      <p className="text-xs text-gray-600 font-light mb-4 leading-relaxed">
                        {L.readingTrailNote}
                      </p>
                      <div className="space-y-4">
                        {readingTrailLinks.map((sourceLink, sourceIndex) => (
                          <a
                            key={sourceLink.url + sourceIndex}
                            href={sourceLink.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block border border-[#141414] bg-white px-4 py-4 hover:bg-[#141414] hover:text-white transition-colors group"
                            title={L.tipOpenArticle}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="font-semibold text-sm uppercase tracking-wide break-words">{sourceLink.title}</div>
                                <div className="text-[11px] opacity-60 mt-2 break-all">{sourceLink.hostname}</div>
                              </div>
                              <ArrowUpRight size={16} className="shrink-0 mt-0.5 opacity-70 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
                            </div>
                          </a>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-6">

                      {hostnames.length > 0 && (
                        <div className="border border-[#141414]/10 bg-[#FAFAFA] p-6">
                          <div className="text-[10px] uppercase font-bold tracking-[0.24em] text-[#141414]/60 mb-3">
                            {L.verifiedDomains}
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {hostnames.map((hostname) => (
                              <span key={hostname} className="px-3 py-1.5 border border-[#141414]/15 bg-white text-[10px] uppercase font-bold tracking-[0.16em] text-[#141414]/75">
                                {hostname}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                <div className="mt-auto pt-10 flex justify-between items-center border-t border-[#141414]/5 text-[10px] font-mono opacity-40 print:hidden">
                  <span>{L.evolutionaryNode} {index + 1}.{chapter.visualSeed?.length || 0}</span>
                  <span>{L.upper(L.pageShort(glossaryPageNumber))}</span>
                </div>
              </section>
            </React.Fragment>
          );
        })}
      </div>

      <section id={`page-${finalDocumentPageNumber}`} data-pdf-page-number={String(finalDocumentPageNumber)} data-pdf-page-kind="footer" className="web-book-page p-10 md:p-16 bg-[#F5F5F5] border border-[#141414] shadow-[12px_12px_0px_0px_rgba(20,20,20,0.12)] min-h-[170px] md:min-h-[210px] flex flex-col justify-end gap-4 w-full print:shadow-none print:border-none print:block print:min-h-0 print:h-auto">
        <div className="flex items-end justify-between gap-4">
          <div className="flex items-center gap-4 min-w-0 flex-1">
            <div className="w-10 h-10 rounded-full bg-green-100 flex items-center justify-center">
              <CheckCircle2 className="text-green-600" size={20} />
            </div>
            <div className="flex flex-col">
              <span className="text-[10px] uppercase font-bold tracking-widest">{L.synthesisVerified}</span>
              <span className="text-[9px] opacity-50 font-mono text-left">{L.passComplete}</span>
            </div>
          </div>
          <a
            href="#top"
            target="_self"
            data-pdf-target-page={1}
            title={L.tipScrollTop}
            className="shrink-0 text-[10px] uppercase font-bold hover:underline inline-flex items-center justify-end gap-2 text-right"
          >
            {L.backToTop}
          </a>
        </div>
        <div className="text-[10px] font-mono opacity-40 print:hidden">{L.upper(L.pageShort(finalDocumentPageNumber))}</div>
      </section>
    </div>
  );
}
