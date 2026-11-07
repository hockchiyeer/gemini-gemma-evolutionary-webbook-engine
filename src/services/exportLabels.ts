/**
 * Locale-aware fixed labels for the Web-Book reader and every export format (TXT, High-Res PDF, Word, HTML,
 * Print Friendly PDF/JPG).
 *
 * The generated book text is written in the language of the query, so the fixed labels around it
 * ("CHAPTER 1", "Visual concept", "Core concepts", "Sources", ...) must follow the same language instead of staying
 * English. The language is detected from the book itself (script for CJK, a stop-word vote for a few Latin-script
 * languages). Anything that is not confidently detected stays English, so English books are unchanged.
 */
import type { WebBook } from '../types';

export type BookLocale = 'en' | 'zh-Hans' | 'zh-Hant' | 'ja' | 'ko' | 'ms' | 'es' | 'fr' | 'de';

export interface ExportLabels {
  locale: BookLocale;
  /** BCP-47 tag used for date formatting (undefined = the viewer's own locale, as before for English books). */
  dateLocale: string | undefined;
  engineName: string;
  tagline: string;
  chapters: string;
  concepts: string;
  date: string;
  tableOfContents: string;
  tocHint: string;
  overviewNarrative: string;
  visualConcept: string;
  visualConceptSeed: string;
  coreConcepts: string;
  keyDomainConcepts: string;
  keyDimensions: string;
  subTopics: string;
  deeperAngles: string;
  sources: string;
  verifiedSources: string;
  sourceArticle: string;
  technicalGlossary: string;
  referenceAndSources: string;
  synthesisVerified: string;
  passComplete: string;
  backToTop: string;
  generatedOn: string;
  evidenceSynthesisTitle: string;
  fallbackSearch: string;
  groundedAi: string;
  deepAnalysis: string;
  passCompleteDoc: string;
  docNote: string;
  generatedBy: string;
  overview: string;
  evidenceContext: string;
  synthesisImplications: string;
  continuation: string;
  referencePage: string;
  sourceVerification: string;
  verifiedDomains: string;
  inspectSource: string;
  deeperAnglesShort: string;
  coreTerms: string;
  readingTrail: string;
  readingTrailNote: string;
  noSupportingSource: string;
  evolutionaryNode: string;
  tipOpenArticle: string;
  tipOpenAngle: string;
  tipReadTerm: string;
  tipVerifyChapter: string;
  tipScrollTop: string;
  abstract: string;
  conclusionText: string;
  modelKnowledge: string;
  /** "10 chapters" */
  chapterCount: (n: number) => string;
  /** One-sentence overview used when a book has no generation note. */
  overviewFallback: (topic: string) => string;
  offlineOverview: (topic: string, sources: number, sentences: number, words: number) => string;
  /** "CHAPTER 3" */
  chapter: (n: number) => string;
  /** "CHAPTER 3 OF 10" */
  chapterOf: (n: number, total: number) => string;
  /** "Chapter 3 / 10" (reader) */
  chapterSlash: (n: number, total: number) => string;
  /** "PAGE 3" (reader page marker) */
  pageShort: (n: number) => string;
  /** "PAGE 3 OF 22" */
  pageOf: (page: number, total: number) => string;
  /** "P. 3" (table of contents page reference) */
  pageRef: (page: number) => string;
  /** "Navigate to Chapter 3" (link tooltip) */
  navigateTo: (n: number) => string;
  /** "36 core concepts" */
  conceptCount: (n: number) => string;
  /** "10 chapters | 12 document sections" */
  chaptersAndSections: (chapters: number, sections: number) => string;
  /** Separator between a label and its value: full-width for Chinese and Japanese. */
  colon: string;
  /** Upper-cases Latin text; CJK text is unaffected. */
  upper: (text: string) => string;
}

interface Dictionary {
  dateLocale: string | undefined;
  engineName: string;
  tagline: string;
  chapters: string;
  concepts: string;
  date: string;
  tableOfContents: string;
  tocHint: string;
  overviewNarrative: string;
  visualConcept: string;
  visualConceptSeed: string;
  coreConcepts: string;
  keyDomainConcepts: string;
  keyDimensions: string;
  subTopics: string;
  deeperAngles: string;
  sources: string;
  verifiedSources: string;
  sourceArticle: string;
  technicalGlossary: string;
  referenceAndSources: string;
  synthesisVerified: string;
  passComplete: string;
  backToTop: string;
  generatedOn: string;
  evidenceSynthesisTitle: string;
  fallbackSearch: string;
  groundedAi: string;
  deepAnalysis: string;
  passCompleteDoc: string;
  docNote: string;
  generatedBy: string;
  overview: string;
  evidenceContext: string;
  synthesisImplications: string;
  continuation: string;
  referencePage: string;
  sourceVerification: string;
  verifiedDomains: string;
  inspectSource: string;
  deeperAnglesShort: string;
  coreTerms: string;
  readingTrail: string;
  readingTrailNote: string;
  noSupportingSource: string;
  evolutionaryNode: string;
  tipOpenArticle: string;
  tipOpenAngle: string;
  tipReadTerm: string;
  tipVerifyChapter: string;
  tipScrollTop: string;
  abstract: string;
  conclusionText: string;
  modelKnowledge: string;
  chapterCount: (n: number) => string;
  overviewFallback: (topic: string) => string;
  offlineOverview: (topic: string, sources: number, sentences: number, words: number) => string;
  chapter: (n: number) => string;
  chapterOf: (n, total: number) => string;
  chapterSlash: (n: number, total: number) => string;
  pageShort: (n: number) => string;
  pageOf: (page: number, total: number) => string;
  pageRef: (page: number) => string;
  navigateTo: (n: number) => string;
  conceptCount: (n: number) => string;
  chaptersAndSections: (chapters: number, sections: number) => string;
}

const EN: Dictionary = {
  dateLocale: undefined,
  engineName: 'Evolutionary Web-Book Engine',
  tagline: 'Mitigating search redundancy via evolutionary computing',
  chapters: 'Chapters',
  concepts: 'Concepts',
  date: 'Date',
  tableOfContents: 'Table of Contents',
  tocHint: 'Click any chapter to navigate directly',
  overviewNarrative: 'Overview & Narrative',
  visualConcept: 'Visual concept',
  visualConceptSeed: 'Visual concept seed',
  coreConcepts: 'Core concepts',
  keyDomainConcepts: 'Key domain concepts',
  keyDimensions: 'Key dimensions',
  subTopics: 'Sub-topics',
  deeperAngles: 'Deeper angles & exploration',
  sources: 'Sources',
  verifiedSources: 'Verified source citations',
  sourceArticle: 'Source Article',
  technicalGlossary: 'Technical Glossary',
  referenceAndSources: 'Reference & Sources',
  synthesisVerified: 'Synthesis verified',
  passComplete: 'Engine v2.5 - Evolutionary Pass Complete',
  backToTop: 'Back to Top',
  generatedOn: 'Generated on',
  evidenceSynthesisTitle: 'Evolutionary Synthesis & Evidence Verification',
  fallbackSearch: 'Fallback search',
  groundedAi: 'Grounded AI',
  deepAnalysis: 'Deep Analysis & Sub-Topics',
  passCompleteDoc: 'Engine v2.5 | Evolutionary pass complete.',
  docNote: 'This document was generated from the current Web-book view and packaged as a native .docx file with embedded chapter images.',
  generatedBy: 'Generated by the Evolutionary Web-Book Engine.',
  overview: 'Overview',
  evidenceContext: 'Evidence & Context',
  synthesisImplications: 'Synthesis & Implications',
  continuation: 'Continuation',
  referencePage: 'Reference Page',
  sourceVerification: 'Source Verification',
  verifiedDomains: 'Verified Source Domains',
  inspectSource: 'Inspect Source',
  deeperAnglesShort: 'Deeper Angles',
  coreTerms: 'Core Terms',
  readingTrail: 'Credible Reading Trail',
  readingTrailNote: 'Curated source materials and primary references synthesized for this chapter.',
  noSupportingSource: 'No supporting source link is available for this chapter.',
  evolutionaryNode: 'Evolutionary Node',
  tipOpenArticle: 'Open the supporting article in a new tab',
  tipOpenAngle: 'Open the supporting article for this angle',
  tipReadTerm: 'Read the source behind this term',
  tipVerifyChapter: 'Verify this chapter at a supporting source',
  tipScrollTop: 'Scroll back to the beginning of the book',
  abstract: 'Abstract',
  conclusionText: 'This full-text report was produced using multi-generational genetic algorithms that evaluate informative novelty while pruning repetitive search fragments. All references have been normalized and validated against primary source hostnames.',
  modelKnowledge: 'Model knowledge (not verified against live sources)',
  chapterCount: (n) => `${n} ${n === 1 ? 'chapter' : 'chapters'}`,
  overviewFallback: (topic) => `Comprehensive evolutionary synthesis covering foundations, core mechanisms, and future horizons for "${topic}".`,
  offlineOverview: (topic, sources, sentences, words) => `Compiled offline, without an AI model, from ${sources} web sources (${sentences} sentences, ${words} words) on \"${topic}\".`,
  chapter: (n) => `Chapter ${n}`,
  chapterOf: (n, total) => `Chapter ${n} of ${total}`,
  chapterSlash: (n, total) => `Chapter ${n} / ${total}`,
  pageShort: (n) => `Page ${n}`,
  pageOf: (page, total) => `Page ${page} of ${total}`,
  pageRef: (page) => `P. ${page}`,
  navigateTo: (n) => `Navigate to Chapter ${n}`,
  conceptCount: (n) => `${n} core ${n === 1 ? 'concept' : 'concepts'}`,
  chaptersAndSections: (c, d) => `${c} chapters | ${d} document sections`,
};

const ZH_HANS: Dictionary = {
  dateLocale: 'zh-CN',
  engineName: '演化式网络书引擎',
  tagline: '以演化计算缓解搜索冗余',
  chapters: '章节',
  concepts: '概念',
  date: '日期',
  tableOfContents: '目录',
  tocHint: '点击任意章节可直接跳转',
  overviewNarrative: '概述与叙事',
  visualConcept: '视觉概念',
  visualConceptSeed: '视觉概念提示',
  coreConcepts: '核心概念',
  keyDomainConcepts: '核心领域概念',
  keyDimensions: '关键维度',
  subTopics: '小标题',
  deeperAngles: '深入视角与延伸探索',
  sources: '参考资料出处',
  verifiedSources: '已验证的来源引用',
  sourceArticle: '来源文章',
  technicalGlossary: '术语表',
  referenceAndSources: '参考与来源',
  synthesisVerified: '综合分析已验证',
  passComplete: '引擎 v2.5 - 演化流程已完成',
  backToTop: '返回顶部',
  generatedOn: '生成时间',
  evidenceSynthesisTitle: '演化综合与证据核验',
  fallbackSearch: '备用搜索',
  groundedAi: '联网检索 AI',
  deepAnalysis: '深度分析与子主题',
  passCompleteDoc: '引擎 v2.5 | 演化流程已完成。',
  docNote: '本文档根据当前网络书视图生成，并打包为内嵌章节图片的原生 .docx 文件。',
  generatedBy: '由演化式网络书引擎生成。',
  overview: '概述',
  evidenceContext: '证据与背景',
  synthesisImplications: '综合与启示',
  continuation: '续页',
  referencePage: '参考页',
  sourceVerification: '来源核验',
  verifiedDomains: '已验证的来源域名',
  inspectSource: '查看来源',
  deeperAnglesShort: '深入视角',
  coreTerms: '核心术语',
  readingTrail: '可信阅读路径',
  readingTrailNote: '为本章综合整理的精选来源资料与原始参考文献。',
  noSupportingSource: '本章暂无可用的支持来源链接。',
  evolutionaryNode: '演化节点',
  tipOpenArticle: '在新标签页中打开支持文章',
  tipOpenAngle: '打开该视角的支持文章',
  tipReadTerm: '阅读该术语背后的来源',
  tipVerifyChapter: '通过支持来源核验本章',
  tipScrollTop: '返回本书开头',
  abstract: '摘要',
  conclusionText: '本完整报告通过多代遗传算法生成，该算法在剔除重复搜索片段的同时评估信息的新颖性。所有参考来源均已标准化，并与原始来源的主机名进行了核验。',
  modelKnowledge: '模型知识（未经实时来源验证）',
  chapterCount: (n) => `${n} 章`,
  overviewFallback: (topic) => `围绕“${topic}”的基础、核心机制与未来展望的综合性演化综合分析。`,
  offlineOverview: (topic, sources, sentences, words) => `在没有可用 AI 模型的情况下，依据 ${sources} 个网络来源（${sentences} 句，约 ${words} 字）离线整理的“${topic}”综合报告。`,
  chapter: (n) => `第${n}章`,
  chapterOf: (n, total) => `第 ${n} 章 / 共 ${total} 章`,
  chapterSlash: (n, total) => `第 ${n} 章 / ${total}`,
  pageShort: (n) => `第 ${n} 页`,
  pageOf: (page, total) => `第 ${page} 页 / 共 ${total} 页`,
  pageRef: (page) => `第${page}页`,
  navigateTo: (n) => `跳转到第${n}章`,
  conceptCount: (n) => `${n} 个核心概念`,
  chaptersAndSections: (c, d) => `${c} 章 | ${d} 个文档分节`,
};

const ZH_HANT: Dictionary = {
  dateLocale: 'zh-TW',
  engineName: '演化式網路書引擎',
  tagline: '以演化運算緩解搜尋冗餘',
  chapters: '章節',
  concepts: '概念',
  date: '日期',
  tableOfContents: '目錄',
  tocHint: '點擊任一章節可直接跳轉',
  overviewNarrative: '概述與敘事',
  visualConcept: '視覺概念',
  visualConceptSeed: '視覺概念提示',
  coreConcepts: '核心概念',
  keyDomainConcepts: '核心領域概念',
  keyDimensions: '關鍵維度',
  subTopics: '小標題',
  deeperAngles: '深入視角與延伸探索',
  sources: '參考資料出處',
  verifiedSources: '已驗證的來源引用',
  sourceArticle: '來源文章',
  technicalGlossary: '術語表',
  referenceAndSources: '參考與來源',
  synthesisVerified: '綜合分析已驗證',
  passComplete: '引擎 v2.5 - 演化流程已完成',
  backToTop: '返回頂部',
  generatedOn: '產生時間',
  evidenceSynthesisTitle: '演化綜合與證據核驗',
  fallbackSearch: '備用搜尋',
  groundedAi: '連網檢索 AI',
  deepAnalysis: '深度分析與子主題',
  passCompleteDoc: '引擎 v2.5 | 演化流程已完成。',
  docNote: '本文件根據目前網路書檢視畫面產生，並封裝為內嵌章節圖片的原生 .docx 檔案。',
  generatedBy: '由演化式網路書引擎產生。',
  overview: '概述',
  evidenceContext: '證據與背景',
  synthesisImplications: '綜合與啟示',
  continuation: '續頁',
  referencePage: '參考頁',
  sourceVerification: '來源核驗',
  verifiedDomains: '已驗證的來源網域',
  inspectSource: '檢視來源',
  deeperAnglesShort: '深入視角',
  coreTerms: '核心術語',
  readingTrail: '可信閱讀路徑',
  readingTrailNote: '為本章綜合整理的精選來源資料與原始參考文獻。',
  noSupportingSource: '本章暫無可用的支持來源連結。',
  evolutionaryNode: '演化節點',
  tipOpenArticle: '在新分頁中開啟支持文章',
  tipOpenAngle: '開啟該視角的支持文章',
  tipReadTerm: '閱讀該術語背後的來源',
  tipVerifyChapter: '透過支持來源核驗本章',
  tipScrollTop: '返回本書開頭',
  abstract: '摘要',
  conclusionText: '本完整報告透過多代遺傳演算法產生，該演算法在剔除重複搜尋片段的同時評估資訊的新穎性。所有參考來源均已標準化，並與原始來源的主機名稱進行核驗。',
  modelKnowledge: '模型知識（未經即時來源驗證）',
  chapterCount: (n) => `${n} 章`,
  overviewFallback: (topic) => `圍繞「${topic}」的基礎、核心機制與未來展望的綜合性演化綜合分析。`,
  offlineOverview: (topic, sources, sentences, words) => `在沒有可用 AI 模型的情況下，依據 ${sources} 個網路來源（${sentences} 句，約 ${words} 字）離線整理的「${topic}」綜合報告。`,
  chapter: (n) => `第${n}章`,
  chapterOf: (n, total) => `第 ${n} 章 / 共 ${total} 章`,
  chapterSlash: (n, total) => `第 ${n} 章 / ${total}`,
  pageShort: (n) => `第 ${n} 頁`,
  pageOf: (page, total) => `第 ${page} 頁 / 共 ${total} 页`,
  pageRef: (page) => `第${page}頁`,
  navigateTo: (n) => `跳轉到第${n}章`,
  conceptCount: (n) => `${n} 個核心概念`,
  chaptersAndSections: (c, d) => `${c} 章 | ${d} 個文件分節`,
};

const JA: Dictionary = {
  dateLocale: 'ja-JP',
  engineName: '進化型ウェブブックエンジン',
  tagline: '進化的計算で検索の冗長性を低減',
  chapters: '章',
  concepts: '概念',
  date: '日付',
  tableOfContents: '目次',
  tocHint: '章をクリックすると該当箇所へ移動します',
  overviewNarrative: '概要と解説',
  visualConcept: 'ビジュアルコンセプト',
  visualConceptSeed: 'ビジュアルコンセプト案',
  coreConcepts: '主要概念',
  keyDomainConcepts: '主要な分野概念',
  keyDimensions: '主要な観点',
  subTopics: 'サブトピック',
  deeperAngles: 'さらなる視点と探究',
  sources: '出典',
  verifiedSources: '検証済みの出典',
  sourceArticle: '出典記事',
  technicalGlossary: '用語集',
  referenceAndSources: '参考文献・出典',
  synthesisVerified: '統合を検証済み',
  passComplete: 'エンジン v2.5 - 進化プロセス完了',
  backToTop: 'ページ上部へ',
  generatedOn: '生成日時',
  evidenceSynthesisTitle: '進化的統合とエビデンス検証',
  fallbackSearch: '代替検索',
  groundedAi: '検索連動AI',
  deepAnalysis: '詳細分析とサブトピック',
  passCompleteDoc: 'エンジン v2.5 | 進化プロセス完了。',
  docNote: 'この文書は現在のウェブブック表示から生成され、章の画像を埋め込んだネイティブ .docx ファイルとして出力されています。',
  generatedBy: '進化型ウェブブックエンジンにより生成。',
  overview: '概要',
  evidenceContext: '根拠と背景',
  synthesisImplications: '統合と示唆',
  continuation: '続き',
  referencePage: '参考ページ',
  sourceVerification: '出典の検証',
  verifiedDomains: '検証済みの出典ドメイン',
  inspectSource: '出典を確認',
  deeperAnglesShort: 'さらなる視点',
  coreTerms: '主要用語',
  readingTrail: '信頼できる読書ルート',
  readingTrailNote: 'この章のために統合された厳選資料と一次参考文献。',
  noSupportingSource: 'この章に利用できる裏付け出典リンクはありません。',
  evolutionaryNode: '進化ノード',
  tipOpenArticle: '裏付け記事を新しいタブで開く',
  tipOpenAngle: 'この視点の裏付け記事を開く',
  tipReadTerm: 'この用語の出典を読む',
  tipVerifyChapter: '裏付け出典でこの章を検証する',
  tipScrollTop: '本の先頭に戻る',
  abstract: '要旨',
  conclusionText: 'この完全版レポートは、多世代の遺伝的アルゴリズムを用いて、情報の新規性を評価しつつ重複した検索断片を除去して作成されました。すべての参照先は正規化され、一次情報源のホスト名と照合されています。',
  modelKnowledge: 'モデルの知識（ライブの情報源では未検証）',
  chapterCount: (n) => `${n} 章`,
  overviewFallback: (topic) => `「${topic}」の基礎、中核となる仕組み、将来の展望を網羅する包括的な進化的統合。`,
  offlineOverview: (topic, sources, sentences, words) => `AI モデルを利用できない状況で、${sources} 件のウェブ情報源（${sentences} 文、約 ${words} 語）からオフラインでまとめた「${topic}」の統合レポートです。`,
  chapter: (n) => `第${n}章`,
  chapterOf: (n, total) => `第${n}章 / 全${total}章`,
  chapterSlash: (n, total) => `第${n}章 / ${total}`,
  pageShort: (n) => `${n} ページ`,
  pageOf: (page, total) => `${page} / ${total} ページ`,
  pageRef: (page) => `${page}ページ`,
  navigateTo: (n) => `第${n}章へ移動`,
  conceptCount: (n) => `主要概念 ${n} 件`,
  chaptersAndSections: (c, d) => `${c} 章 | ${d} 文書セクション`,
};

const KO: Dictionary = {
  dateLocale: 'ko-KR',
  engineName: '진화형 웹북 엔진',
  tagline: '진화 연산으로 검색 중복을 줄입니다',
  chapters: '장',
  concepts: '개념',
  date: '날짜',
  tableOfContents: '목차',
  tocHint: '장을 클릭하면 해당 위치로 이동합니다',
  overviewNarrative: '개요와 서술',
  visualConcept: '시각 콘셉트',
  visualConceptSeed: '시각 콘셉트 제안',
  coreConcepts: '핵심 개념',
  keyDomainConcepts: '핵심 분야 개념',
  keyDimensions: '주요 관점',
  subTopics: '하위 주제',
  deeperAngles: '심화 관점과 탐구',
  sources: '출처',
  verifiedSources: '검증된 출처 인용',
  sourceArticle: '출처 기사',
  technicalGlossary: '용어집',
  referenceAndSources: '참고 자료 및 출처',
  synthesisVerified: '종합 검증 완료',
  passComplete: '엔진 v2.5 - 진화 과정 완료',
  backToTop: '맨 위로',
  generatedOn: '생성 일시',
  evidenceSynthesisTitle: '진화적 종합 및 근거 검증',
  fallbackSearch: '대체 검색',
  groundedAi: '검색 연동 AI',
  deepAnalysis: '심층 분석 및 하위 주제',
  passCompleteDoc: '엔진 v2.5 | 진화 과정 완료.',
  docNote: '이 문서는 현재 웹북 보기에서 생성되었으며 장 이미지가 포함된 기본 .docx 파일로 저장되었습니다.',
  generatedBy: '진화형 웹북 엔진이 생성했습니다.',
  overview: '개요',
  evidenceContext: '근거와 배경',
  synthesisImplications: '종합과 시사점',
  continuation: '계속',
  referencePage: '참고 페이지',
  sourceVerification: '출처 검증',
  verifiedDomains: '검증된 출처 도메인',
  inspectSource: '출처 확인',
  deeperAnglesShort: '심화 관점',
  coreTerms: '핵심 용어',
  readingTrail: '신뢰할 수 있는 읽기 경로',
  readingTrailNote: '이 장을 위해 종합한 엄선된 출처 자료와 1차 참고 문헌입니다.',
  noSupportingSource: '이 장에 사용할 수 있는 뒷받침 출처 링크가 없습니다.',
  evolutionaryNode: '진화 노드',
  tipOpenArticle: '뒷받침 기사를 새 탭에서 열기',
  tipOpenAngle: '이 관점의 뒷받침 기사 열기',
  tipReadTerm: '이 용어의 출처 읽기',
  tipVerifyChapter: '뒷받침 출처로 이 장 검증하기',
  tipScrollTop: '책의 맨 처음으로 이동',
  abstract: '요약',
  conclusionText: '이 전체 보고서는 다세대 유전 알고리즘을 사용해 정보의 참신성을 평가하고 반복되는 검색 조각을 제거하여 작성되었습니다. 모든 참고 자료는 정규화되었으며 원본 출처의 호스트 이름과 대조 검증되었습니다.',
  modelKnowledge: '모델 지식(실시간 출처로 검증되지 않음)',
  chapterCount: (n) => `${n}개 장`,
  overviewFallback: (topic) => `"${topic}"의 기초, 핵심 메커니즘, 미래 전망을 아우르는 종합적인 진화적 종합 분석입니다.`,
  offlineOverview: (topic, sources, sentences, words) => `AI 모델을 사용할 수 없는 상태에서 ${sources}개의 웹 출처(${sentences}문장, 약 ${words}단어)를 바탕으로 오프라인으로 정리한 \"${topic}\" 종합 보고서입니다.`,
  chapter: (n) => `제${n}장`,
  chapterOf: (n, total) => `제${n}장 / 총 ${total}장`,
  chapterSlash: (n, total) => `제${n}장 / ${total}`,
  pageShort: (n) => `${n} 페이지`,
  pageOf: (page, total) => `${page} / ${total} 페이지`,
  pageRef: (page) => `${page}쪽`,
  navigateTo: (n) => `제${n}장으로 이동`,
  conceptCount: (n) => `핵심 개념 ${n}개`,
  chaptersAndSections: (c, d) => `${c}개 장 | ${d}개 문서 섹션`,
};

const MS: Dictionary = {
  dateLocale: 'ms-MY',
  engineName: 'Enjin Buku Web Evolusi',
  tagline: 'Mengurangkan lebihan carian melalui pengkomputeran evolusi',
  chapters: 'Bab',
  concepts: 'Konsep',
  date: 'Tarikh',
  tableOfContents: 'Kandungan',
  tocHint: 'Klik mana-mana bab untuk terus ke bab tersebut',
  overviewNarrative: 'Gambaran & Naratif',
  visualConcept: 'Konsep visual',
  visualConceptSeed: 'Idea konsep visual',
  coreConcepts: 'Konsep teras',
  keyDomainConcepts: 'Konsep domain utama',
  keyDimensions: 'Dimensi utama',
  subTopics: 'Subtopik',
  deeperAngles: 'Sudut lebih mendalam & penerokaan',
  sources: 'Sumber',
  verifiedSources: 'Petikan sumber yang disahkan',
  sourceArticle: 'Artikel Sumber',
  technicalGlossary: 'Glosari Teknikal',
  referenceAndSources: 'Rujukan & Sumber',
  synthesisVerified: 'Sintesis disahkan',
  passComplete: 'Enjin v2.5 - Laluan Evolusi Selesai',
  backToTop: 'Kembali ke Atas',
  generatedOn: 'Dijana pada',
  evidenceSynthesisTitle: 'Sintesis Evolusi & Pengesahan Bukti',
  fallbackSearch: 'Carian sandaran',
  groundedAi: 'AI berpaksikan carian',
  deepAnalysis: 'Analisis Mendalam & Subtopik',
  passCompleteDoc: 'Enjin v2.5 | Laluan evolusi selesai.',
  docNote: 'Dokumen ini dijana daripada paparan buku web semasa dan dipakej sebagai fail .docx asli dengan imej bab tertanam.',
  generatedBy: 'Dijana oleh Enjin Buku Web Evolusi.',
  overview: 'Gambaran',
  evidenceContext: 'Bukti & Konteks',
  synthesisImplications: 'Sintesis & Implikasi',
  continuation: 'Sambungan',
  referencePage: 'Halaman Rujukan',
  sourceVerification: 'Pengesahan Sumber',
  verifiedDomains: 'Domain Sumber Disahkan',
  inspectSource: 'Semak Sumber',
  deeperAnglesShort: 'Sudut Lebih Mendalam',
  coreTerms: 'Istilah Teras',
  readingTrail: 'Laluan Bacaan Berwibawa',
  readingTrailNote: 'Bahan sumber terpilih dan rujukan utama yang disintesiskan untuk bab ini.',
  noSupportingSource: 'Tiada pautan sumber sokongan untuk bab ini.',
  evolutionaryNode: 'Nod Evolusi',
  tipOpenArticle: 'Buka artikel sokongan dalam tab baharu',
  tipOpenAngle: 'Buka artikel sokongan untuk sudut ini',
  tipReadTerm: 'Baca sumber di sebalik istilah ini',
  tipVerifyChapter: 'Sahkan bab ini pada sumber sokongan',
  tipScrollTop: 'Tatal kembali ke permulaan buku',
  abstract: 'Abstrak',
  conclusionText: 'Laporan penuh ini dihasilkan menggunakan algoritma genetik pelbagai generasi yang menilai kebaharuan maklumat sambil menyingkirkan serpihan carian yang berulang. Semua rujukan telah dinormalkan dan disahkan berdasarkan nama hos sumber utama.',
  modelKnowledge: 'Pengetahuan model (tidak disahkan dengan sumber langsung)',
  chapterCount: (n) => `${n} bab`,
  overviewFallback: (topic) => `Sintesis evolusi menyeluruh yang merangkumi asas, mekanisme teras dan ufuk masa depan bagi "${topic}".`,
  offlineOverview: (topic, sources, sentences, words) => `Laporan sintesis \"${topic}\" yang disusun luar talian, tanpa model AI, daripada ${sources} sumber web (${sentences} ayat, ${words} perkataan).`,
  chapter: (n) => `Bab ${n}`,
  chapterOf: (n, total) => `Bab ${n} daripada ${total}`,
  chapterSlash: (n, total) => `Bab ${n} / ${total}`,
  pageShort: (n) => `Halaman ${n}`,
  pageOf: (page, total) => `Halaman ${page} daripada ${total}`,
  pageRef: (page) => `Hlm. ${page}`,
  navigateTo: (n) => `Pergi ke Bab ${n}`,
  conceptCount: (n) => `${n} konsep teras`,
  chaptersAndSections: (c, d) => `${c} bab | ${d} bahagian dokumen`,
};

const ES: Dictionary = {
  dateLocale: 'es-ES',
  engineName: 'Motor evolutivo de libros web',
  tagline: 'Reduce la redundancia de búsqueda mediante computación evolutiva',
  chapters: 'Capítulos',
  concepts: 'Conceptos',
  date: 'Fecha',
  tableOfContents: 'Índice',
  tocHint: 'Haga clic en un capítulo para ir directamente',
  overviewNarrative: 'Visión general y narrativa',
  visualConcept: 'Concepto visual',
  visualConceptSeed: 'Idea de concepto visual',
  coreConcepts: 'Conceptos clave',
  keyDomainConcepts: 'Conceptos clave del dominio',
  keyDimensions: 'Dimensiones clave',
  subTopics: 'Subtemas',
  deeperAngles: 'Enfoques más profundos y exploración',
  sources: 'Fuentes',
  verifiedSources: 'Citas de fuentes verificadas',
  sourceArticle: 'Artículo fuente',
  technicalGlossary: 'Glosario técnico',
  referenceAndSources: 'Referencias y fuentes',
  synthesisVerified: 'Síntesis verificada',
  passComplete: 'Motor v2.5 - Pase evolutivo completado',
  backToTop: 'Volver arriba',
  generatedOn: 'Generado el',
  evidenceSynthesisTitle: 'Síntesis evolutiva y verificación de evidencias',
  fallbackSearch: 'Búsqueda alternativa',
  groundedAi: 'IA con búsqueda',
  deepAnalysis: 'Análisis en profundidad y subtemas',
  passCompleteDoc: 'Motor v2.5 | Pase evolutivo completado.',
  docNote: 'Este documento se generó a partir de la vista actual del libro web y se empaquetó como un archivo .docx nativo con imágenes de capítulo incrustadas.',
  generatedBy: 'Generado por el motor evolutivo de libros web.',
  overview: 'Visión general',
  evidenceContext: 'Evidencia y contexto',
  synthesisImplications: 'Síntesis e implicaciones',
  continuation: 'Continuación',
  referencePage: 'Página de referencia',
  sourceVerification: 'Verificación de fuentes',
  verifiedDomains: 'Dominios de fuentes verificados',
  inspectSource: 'Inspeccionar fuente',
  deeperAnglesShort: 'Enfoques más profundos',
  coreTerms: 'Términos clave',
  readingTrail: 'Ruta de lectura fiable',
  readingTrailNote: 'Materiales de origen seleccionados y referencias primarias sintetizadas para este capítulo.',
  noSupportingSource: 'No hay ningún enlace de fuente de apoyo para este capítulo.',
  evolutionaryNode: 'Nodo evolutivo',
  tipOpenArticle: 'Abrir el artículo de apoyo en una pestaña nueva',
  tipOpenAngle: 'Abrir el artículo de apoyo para este enfoque',
  tipReadTerm: 'Leer la fuente de este término',
  tipVerifyChapter: 'Verificar este capítulo en una fuente de apoyo',
  tipScrollTop: 'Volver al principio del libro',
  abstract: 'Resumen',
  conclusionText: 'Este informe completo se elaboró con algoritmos genéticos multigeneracionales que evalúan la novedad informativa y eliminan los fragmentos de búsqueda repetitivos. Todas las referencias se han normalizado y validado con los nombres de host de las fuentes primarias.',
  modelKnowledge: 'Conocimiento del modelo (no verificado con fuentes en vivo)',
  chapterCount: (n) => `${n} ${n === 1 ? 'capítulo' : 'capítulos'}`,
  overviewFallback: (topic) => `Síntesis evolutiva integral que abarca los fundamentos, los mecanismos centrales y los horizontes futuros de "${topic}".`,
  offlineOverview: (topic, sources, sentences, words) => `Informe de síntesis sobre \"${topic}\" elaborado sin conexión, sin modelo de IA, a partir de ${sources} fuentes web (${sentences} frases, ${words} palabras).`,
  chapter: (n) => `Capítulo ${n}`,
  chapterOf: (n, total) => `Capítulo ${n} de ${total}`,
  chapterSlash: (n, total) => `Capítulo ${n} / ${total}`,
  pageShort: (n) => `Página ${n}`,
  pageOf: (page, total) => `Página ${page} de ${total}`,
  pageRef: (page) => `Pág. ${page}`,
  navigateTo: (n) => `Ir al capítulo ${n}`,
  conceptCount: (n) => `${n} ${n === 1 ? 'concepto clave' : 'conceptos clave'}`,
  chaptersAndSections: (c, d) => `${c} capítulos | ${d} secciones del documento`,
};

const FR: Dictionary = {
  dateLocale: 'fr-FR',
  engineName: 'Moteur évolutif de livres web',
  tagline: 'Réduire la redondance des recherches par le calcul évolutif',
  chapters: 'Chapitres',
  concepts: 'Concepts',
  date: 'Date',
  tableOfContents: 'Table des matières',
  tocHint: 'Cliquez sur un chapitre pour y accéder directement',
  overviewNarrative: 'Aperçu et récit',
  visualConcept: 'Concept visuel',
  visualConceptSeed: 'Idée de concept visuel',
  coreConcepts: 'Concepts clés',
  keyDomainConcepts: 'Concepts clés du domaine',
  keyDimensions: 'Dimensions clés',
  subTopics: 'Sous-thèmes',
  deeperAngles: 'Angles approfondis et exploration',
  sources: 'Sources',
  verifiedSources: 'Citations de sources vérifiées',
  sourceArticle: 'Article source',
  technicalGlossary: 'Glossaire technique',
  referenceAndSources: 'Références et sources',
  synthesisVerified: 'Synthèse vérifiée',
  passComplete: 'Moteur v2.5 - Passe évolutive terminée',
  backToTop: 'Retour en haut',
  generatedOn: 'Généré le',
  evidenceSynthesisTitle: 'Synthèse évolutive et vérification des preuves',
  fallbackSearch: 'Recherche de secours',
  groundedAi: 'IA avec recherche',
  deepAnalysis: 'Analyse approfondie et sous-thèmes',
  passCompleteDoc: 'Moteur v2.5 | Passe évolutive terminée.',
  docNote: 'Ce document a été généré à partir de la vue actuelle du livre web et empaqueté sous forme de fichier .docx natif avec les images de chapitre intégrées.',
  generatedBy: 'Généré par le moteur évolutif de livres web.',
  overview: 'Aperçu',
  evidenceContext: 'Preuves et contexte',
  synthesisImplications: 'Synthèse et implications',
  continuation: 'Suite',
  referencePage: 'Page de référence',
  sourceVerification: 'Vérification des sources',
  verifiedDomains: 'Domaines de sources vérifiés',
  inspectSource: 'Examiner la source',
  deeperAnglesShort: 'Angles approfondis',
  coreTerms: 'Termes clés',
  readingTrail: 'Parcours de lecture fiable',
  readingTrailNote: 'Sources sélectionnées et références primaires synthétisées pour ce chapitre.',
  noSupportingSource: 'Aucun lien de source à l\'appui n\'est disponible pour ce chapitre.',
  evolutionaryNode: 'Nœud évolutif',
  tipOpenArticle: 'Ouvrir l\'article à l\'appui dans un nouvel onglet',
  tipOpenAngle: 'Ouvrir l\'article à l\'appui pour cet angle',
  tipReadTerm: 'Lire la source de ce terme',
  tipVerifyChapter: 'Vérifier ce chapitre auprès d\'une source à l\'appui',
  tipScrollTop: 'Revenir au début du livre',
  abstract: 'Résumé',
  conclusionText: 'Ce rapport complet a été produit à l\'aide d\'algorithmes génétiques multigénérationnels qui évaluent la nouveauté de l\'information tout en éliminant les fragments de recherche répétitifs. Toutes les références ont été normalisées et validées par rapport aux noms d\'hôte des sources primaires.',
  modelKnowledge: 'Connaissances du modèle (non vérifiées auprès de sources en direct)',
  chapterCount: (n) => `${n} ${n > 1 ? 'chapitres' : 'chapitre'}`,
  overviewFallback: (topic) => `Synthèse évolutive complète couvrant les fondements, les mécanismes essentiels et les perspectives d'avenir de « ${topic} ».`,
  offlineOverview: (topic, sources, sentences, words) => `Synthèse sur « ${topic} » compilée hors ligne, sans modèle d'IA, à partir de ${sources} sources web (${sentences} phrases, ${words} mots).`,
  chapter: (n) => `Chapitre ${n}`,
  chapterOf: (n, total) => `Chapitre ${n} sur ${total}`,
  chapterSlash: (n, total) => `Chapitre ${n} / ${total}`,
  pageShort: (n) => `Page ${n}`,
  pageOf: (page, total) => `Page ${page} sur ${total}`,
  pageRef: (page) => `p. ${page}`,
  navigateTo: (n) => `Aller au chapitre ${n}`,
  conceptCount: (n) => `${n} ${n > 1 ? 'concepts clés' : 'concept clé'}`,
  chaptersAndSections: (c, d) => `${c} chapitres | ${d} sections du document`,
};

const DE: Dictionary = {
  dateLocale: 'de-DE',
  engineName: 'Evolutionäre Webbuch-Engine',
  tagline: 'Suchredundanz durch evolutionäres Rechnen verringern',
  chapters: 'Kapitel',
  concepts: 'Konzepte',
  date: 'Datum',
  tableOfContents: 'Inhaltsverzeichnis',
  tocHint: 'Kapitel anklicken, um direkt dorthin zu springen',
  overviewNarrative: 'Überblick & Darstellung',
  visualConcept: 'Visuelles Konzept',
  visualConceptSeed: 'Idee für visuelles Konzept',
  coreConcepts: 'Kernkonzepte',
  keyDomainConcepts: 'Zentrale Fachkonzepte',
  keyDimensions: 'Wichtige Dimensionen',
  subTopics: 'Unterthemen',
  deeperAngles: 'Vertiefende Perspektiven & Erkundung',
  sources: 'Quellen',
  verifiedSources: 'Verifizierte Quellenangaben',
  sourceArticle: 'Quellenartikel',
  technicalGlossary: 'Fachglossar',
  referenceAndSources: 'Referenzen & Quellen',
  synthesisVerified: 'Synthese verifiziert',
  passComplete: 'Engine v2.5 - Evolutionsdurchlauf abgeschlossen',
  backToTop: 'Nach oben',
  generatedOn: 'Erstellt am',
  evidenceSynthesisTitle: 'Evolutionäre Synthese & Belegprüfung',
  fallbackSearch: 'Ersatzsuche',
  groundedAi: 'KI mit Websuche',
  deepAnalysis: 'Vertiefende Analyse & Unterthemen',
  passCompleteDoc: 'Engine v2.5 | Evolutionsdurchlauf abgeschlossen.',
  docNote: 'Dieses Dokument wurde aus der aktuellen Webbuch-Ansicht erzeugt und als native .docx-Datei mit eingebetteten Kapitelbildern gepackt.',
  generatedBy: 'Erstellt von der Evolutionären Webbuch-Engine.',
  overview: 'Überblick',
  evidenceContext: 'Belege & Kontext',
  synthesisImplications: 'Synthese & Implikationen',
  continuation: 'Fortsetzung',
  referencePage: 'Referenzseite',
  sourceVerification: 'Quellenprüfung',
  verifiedDomains: 'Verifizierte Quelldomains',
  inspectSource: 'Quelle prüfen',
  deeperAnglesShort: 'Vertiefende Perspektiven',
  coreTerms: 'Kernbegriffe',
  readingTrail: 'Verlässlicher Leseweg',
  readingTrailNote: 'Ausgewählte Quellenmaterialien und Primärreferenzen, die für dieses Kapitel zusammengeführt wurden.',
  noSupportingSource: 'Für dieses Kapitel ist kein Link zu einer stützenden Quelle verfügbar.',
  evolutionaryNode: 'Evolutionsknoten',
  tipOpenArticle: 'Den stützenden Artikel in einem neuen Tab öffnen',
  tipOpenAngle: 'Den stützenden Artikel für diese Perspektive öffnen',
  tipReadTerm: 'Die Quelle zu diesem Begriff lesen',
  tipVerifyChapter: 'Dieses Kapitel an einer stützenden Quelle prüfen',
  tipScrollTop: 'Zum Anfang des Buches zurück',
  abstract: 'Zusammenfassung',
  conclusionText: 'Dieser vollständige Bericht wurde mit mehrgenerationalen genetischen Algorithmen erstellt, die den Informationsgehalt bewerten und wiederholte Suchfragmente aussortieren. Alle Referenzen wurden normalisiert und anhand der Hostnamen der Primärquellen geprüft.',
  modelKnowledge: 'Modellwissen (nicht anhand aktueller Quellen verifiziert)',
  chapterCount: (n) => `${n} Kapitel`,
  overviewFallback: (topic) => `Umfassende evolutionäre Synthese zu Grundlagen, Kernmechanismen und Zukunftsperspektiven von „${topic}“.`,
  offlineOverview: (topic, sources, sentences, words) => `Zusammenfassender Bericht zu „${topic}“, ohne KI-Modell offline aus ${sources} Webquellen erstellt (${sentences} Sätze, ${words} Wörter).`,
  chapter: (n) => `Kapitel ${n}`,
  chapterOf: (n, total) => `Kapitel ${n} von ${total}`,
  chapterSlash: (n, total) => `Kapitel ${n} / ${total}`,
  pageShort: (n) => `Seite ${n}`,
  pageOf: (page, total) => `Seite ${page} von ${total}`,
  pageRef: (page) => `S. ${page}`,
  navigateTo: (n) => `Zu Kapitel ${n}`,
  conceptCount: (n) => `${n} ${n === 1 ? 'Kernkonzept' : 'Kernkonzepte'}`,
  chaptersAndSections: (c, d) => `${c} Kapitel | ${d} Dokumentabschnitte`,
};

const DICTIONARIES: Record<BookLocale, Dictionary> = {
  en: EN,
  'zh-Hans': ZH_HANS,
  'zh-Hant': ZH_HANT,
  ja: JA,
  ko: KO,
  ms: MS,
  es: ES,
  fr: FR,
  de: DE,
};

// ---------------------------------------------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------------------------------------------

const HIRAGANA_KATAKANA = /[\u3040-\u30ff\u31f0-\u31ff]/g;
const HANGUL = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/g;
const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;

// Characters whose traditional and simplified forms differ; a book is Traditional when the traditional forms win.
const TRADITIONAL_ONLY = Array.from('這個們來時會對說學從體發經與為麼還點間開關書國過進動業們產現際實質認識環導樣裡團裝選價優鐵歷歲龍應該據認為條許須預備資務種稱構術嚴護歡療護參與總結體險擇權樂濟邊讓議論觀區雖須處驗務舉團盡專廣義習極機練務響類鬥勢');
const SIMPLIFIED_ONLY = Array.from('这个们来时会对说学从体发经与为么还点间开关书国过进动业产现际实质认识环导样团装选价优铁历岁龙应该据条许须预备资务种称构术严护欢疗参总结险择权乐济边让议论观区虽处验举尽专广义习极机练响类斗势');

const LATIN_STOPWORDS: Record<'en' | 'ms' | 'es' | 'fr' | 'de', string[]> = {
  en: ['the', 'and', 'of', 'to', 'in', 'is', 'that', 'for', 'with', 'as', 'are', 'this', 'by', 'on', 'it', 'from'],
  ms: ['yang', 'dan', 'untuk', 'dengan', 'dalam', 'ini', 'itu', 'adalah', 'pada', 'dari', 'kepada', 'tidak', 'oleh', 'atau', 'akan', 'juga'],
  es: ['el', 'la', 'de', 'que', 'y', 'en', 'los', 'las', 'del', 'un', 'una', 'por', 'con', 'para', 'es', 'se'],
  fr: ['le', 'la', 'les', 'des', 'et', 'est', 'une', 'un', 'du', 'dans', 'pour', 'que', 'qui', 'sur', 'au', 'par'],
  de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'ein', 'eine', 'mit', 'von', 'zu', 'den', 'auf', 'für', 'sich', 'auch'],
};

function countMatches(text: string, pattern: RegExp): number {
  return (text.match(pattern) || []).length;
}

/** Picks the fixed-label language for a block of sample text. Returns 'en' unless another language is clear. */
export function detectTextLocale(sample: string): BookLocale {
  const text = (sample || '').slice(0, 6000);
  if (!text.trim()) return 'en';

  const kana = countMatches(text, HIRAGANA_KATAKANA);
  const hangul = countMatches(text, HANGUL);
  const han = countMatches(text, HAN);
  const letters = Math.max(1, countMatches(text, /\p{L}/gu));

  if (hangul >= 4 && hangul >= kana && hangul / letters > 0.1) return 'ko';
  if (kana >= 4 && kana / letters > 0.05) return 'ja';
  if (han >= 4 && han / letters > 0.1) {
    let traditional = 0;
    let simplified = 0;
    for (const char of text) {
      if (TRADITIONAL_ONLY.includes(char)) traditional += 1;
      else if (SIMPLIFIED_ONLY.includes(char)) simplified += 1;
    }
    return traditional > simplified ? 'zh-Hant' : 'zh-Hans';
  }

  const words = text.toLowerCase().match(/[\p{L}']+/gu) || [];
  if (words.length < 30) return 'en';
  const counts = { en: 0, ms: 0, es: 0, fr: 0, de: 0 };
  const stopSets = Object.fromEntries(
    Object.entries(LATIN_STOPWORDS).map(([locale, list]) => [locale, new Set(list)])
  ) as Record<keyof typeof LATIN_STOPWORDS, Set<string>>;
  for (const word of words) {
    (Object.keys(counts) as Array<keyof typeof counts>).forEach((locale) => {
      if (stopSets[locale].has(word)) counts[locale] += 1;
    });
  }
  const ranked = (Object.keys(counts) as Array<keyof typeof counts>)
    .filter((locale) => locale !== 'en')
    .sort((a, b) => counts[b] - counts[a]);
  const best = ranked[0];
  // Latin languages share short words, so demand a clear lead over English before leaving English.
  if (counts[best] >= 12 && counts[best] > counts.en * 1.5) return best;
  return 'en';
}

type LocaleSource = Pick<WebBook, 'topic' | 'chapters'>;

/** Detects the language of a Web-Book from its topic, chapter titles and the start of each chapter. */
export function detectBookLocale(book: LocaleSource | null | undefined): BookLocale {
  if (!book) return 'en';
  const chapters = Array.isArray(book.chapters) ? book.chapters : [];
  const sample = [
    book.topic || '',
    ...chapters.map((chapter) => `${chapter?.title || ''}\n${String(chapter?.content || '').slice(0, 400)}`),
  ].join('\n');
  return detectTextLocale(sample);
}

/** Fixed labels for a locale (English when the locale is unknown). */
export function getExportLabelsForLocale(locale: BookLocale): ExportLabels {
  const dictionary = DICTIONARIES[locale] || EN;
  return {
    ...dictionary,
    locale: DICTIONARIES[locale] ? locale : 'en',
    colon: locale === 'zh-Hans' || locale === 'zh-Hant' || locale === 'ja' ? '：' : ': ',
    upper: (text: string) => text.toUpperCase(),
  };
}

/** Fixed labels matching the language of the given Web-Book. */
export function getExportLabels(book: LocaleSource | null | undefined): ExportLabels {
  return getExportLabelsForLocale(detectBookLocale(book));
}
