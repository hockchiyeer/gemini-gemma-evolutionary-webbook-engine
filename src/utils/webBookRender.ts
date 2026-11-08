import type { Chapter, WebBook, WebBookSourceMode } from "../types.ts";
import { isSnippetOnlySourceMode } from "../types.ts";
import { CJK_CHAR_PATTERN, countWords, splitIntoSentences } from "../services/searchFallbackShared.ts";
import { clipLabelAtWordBoundary } from "../services/documentTitle.ts";
import { cleanChapterContent, cleanTermLabel } from "../services/modelTextCleanup.ts";
import { dedupeByLabel, localizeVisualSeed, removeRepeatedSections } from "./chapterRedundancy.ts";

export { CJK_CHAR_PATTERN, countWords, splitIntoSentences };

// Scraper / page-chrome boilerplate that must never become a definition or sub-topic.
// Deliberately NOT included: topical words such as "cybersecurity", "confidentiality", "intellectual property",
// "disclaimer", "protected by" or a bare "copyright". They are legitimate subjects (a book on security, privacy or
// law is full of them), and rejecting them silently emptied every glossary and sub-topic list of such books.
const POISON_KEYWORDS = [
  "rights reserved",
  "terms of service",
  "privacy policy",
  "unauthorized access",
  "cookie policy",
  "scrapping",
  "bot detection",
  "access denied",
  "legal notice",
  "all rights",
  "terms of use",
  "security warning",
  "amen so be it",
  "and so it shall be",
  "for all eternity",
  "grand design of the universe",
  "版权所有",
  "保留所有权利",
  "点击查看更多",
  "免责声明",
  "隐私政策",
  "服务条款",
  "未经授权不得转载",
  "禁止转载",
  "关于我们",
  "联系我们",
];

const REPEATED_SUBSTRING_PATTERN = /(.{4,})\1{2,}/;
// A real copyright notice (a (c)/© sign or "Copyright 2024"), as opposed to the subject of copyright itself.
const COPYRIGHT_NOTICE_PATTERN = /©|copyright\s*(?:\(c\)|\d{4})/i;
// Machine code listings: an instruction mnemonic followed by a register, hex or immediate operand.
// The previous pattern /\b(mov|push|pop|call|add|sub|int|...)\b/ matched those words anywhere in ordinary prose
// ("call", "add", "pop", "sub" ...), so roughly 1 in 11 normal definitions was thrown away.
const ASSEMBLY_HEURISTIC =
  /\b(?:mov|lea|xor|cmp|push|pop|jmp|call|add|sub|int)\s+(?:[er]?[abcd]x|[abcd][lh]|[er]?[sd]i|[er]?[sb]p|r\d{1,2}[dwb]?|0x[0-9a-f]+|\[[^\]\n]{1,40}\]|\$?-?\d+h?)\s*(?:,|;|$)/im;

/** True when the text looks like a raw assembly / machine-code listing rather than prose. */
export function looksLikeAssemblyCode(text?: string | null): boolean {
  return typeof text === "string" && ASSEMBLY_HEURISTIC.test(text);
}

/** True when the text carries scraper / legal-footer boilerplate. */
export function containsPoisonBoilerplate(...texts: Array<string | null | undefined>): boolean {
  return texts.some((text) => {
    const lowered = (text || "").toLowerCase();
    return POISON_KEYWORDS.some((word) => lowered.includes(word)) || COPYRIGHT_NOTICE_PATTERN.test(text || "");
  });
}
// Interface text that search snippets and scraped pages carry along with the real content: social-media counters,
// library-catalogue export menus, cookie/share/login prompts, contact blocks. None of it is something a source "says".
const PAGE_CHROME_PATTERNS = [
  /^[\d,.\s]+(?:[kKmM]\s+)?(?:followers?|likes?|subscribers?|views?|members?|shares?|comments?|talking about this|粉丝|关注者|人关注|人赞|次观看)\b/i,
  /\b[\d,.]+\s*(?:[kKmM]\s+)?(?:followers?|likes?|subscribers?)\s*[·•|-]/i,
  /\b(?:cite this|export record|export to (?:refworks|endnote\w*|bibtex|ris)|staff view|save to list|email this|text this|print this page|add to (?:cart|basket|favou?rites))\b/i,
  /^(?:skip to (?:main )?content|log ?in|sign ?(?:in|up)|subscribe|follow us|share (?:on|this)|read more|learn more|click here|view (?:all|more)|back to top|related (?:posts|articles)|leave a (?:reply|comment)|menu|search for:?|home\s*[»>|])\b/i,
  /\b(?:this link opens in a new window|opens in a new (?:window|tab)|we use cookies|accept (?:all )?cookies|enable javascript|javascript is (?:disabled|required)|您的浏览器|请开启|点击(?:这里|此处|查看))/i,
  /\b(?:tel|fax|phone|telefon|电话|传真)\s*[:：]\s*\(?\+?\d/i,
  /\bcontact info(?:rmation)?\b.{0,60}\b(?:tel|email|e-mail|fax)\b/i,
  /\b(?:posted|published|updated|last modified)\s+(?:on|by)\b.{0,40}$/i,
];

/** True when the text is website interface or navigation chrome rather than content a source states. */
export function isPageChromeText(text?: string | null): boolean {
  const value = (text || "").replace(/\s+/g, " ").trim();
  if (!value) return false;
  if (PAGE_CHROME_PATTERNS.some((pattern) => pattern.test(value))) return true;
  // A run of Title Case / capitalised fragments with no verb-like connective is a menu, not a sentence.
  const words = value.split(" ");
  if (words.length >= 8 && !/[.!?。！？;；]/.test(value)) {
    const capitalised = words.filter((word) => /^[A-Z][a-z]*$/.test(word)).length;
    return capitalised / words.length >= 0.7;
  }
  return false;
}
const CJK_SENTENCE_END_PATTERN = /[。！？][”’」』）)]*$/;
export const MIN_CHAPTER_TEXT_PAGES = 3;
const TARGET_WORDS_PER_TEXT_PAGE = 250;
export const CHAPTER_NUMBER_PREFIX = /^\s*(?:(?:chapter|ch\.?|part|section)\s*\d+\s*[:.\-–—)]?\s*|第\s*[0-9一二三四五六七八九十百]+\s*[章节節部分]\s*[:：.\-–—]?\s*|\d+\s*[:.)\-–—]\s*)+/i;
const STRUCTURED_EXPORT_HEADING_PATTERN = /^(?:VISUAL CONCEPT|CORE CONCEPTS|SUB-TOPICS|SOURCES|DEFINITIONS|GLOSSARY|TECHNICAL GLOSSARY)\s*:/i;
const EXPORT_METADATA_LINE_PATTERN = /^(?:Generated on:\s*.*|CHAPTER\s+\d+\s*(?::\s*)?)$/i;
const JSONISH_KEY_PATTERN = /"(?:url|title|content|definitions|subTopics|summary|term|description|sourceUrl|priorityScore|informativeScore|authorityScore)"\s*:/i;
const DOMAINISH_PATTERN = /\b(?:https?:\/\/|www\.|(?:[a-z0-9-]+\.)+(?:com|org|net|edu|gov|io|co(?:\.[a-z]{2})?|ac\.uk|co\.uk))\S*/gi;
const URLISH_INLINE_PATTERN = /\b(?:https?:\/\/|www\.|(?:[a-z0-9-]+\.)+(?:com|org|net|edu|gov|[a-z]{2})(?:\.[a-z]{2})?\/)\S*/gi;
const ISO_TIMESTAMP_PATTERN = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/;
const ISO_TIMESTAMP_GLOBAL_PATTERN = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g;
const BULLET_LINE_PATTERN = /^(?:[-*]|\d+[.)])\s+/;
const GENERIC_SYNTHESIS_SENTENCE_PATTERNS = [
  /^\s*overall,\s*the available search evidence keeps\b/i,
  /^\s*coverage of\b.+\b(?:draws on several related sources and recurring themes|repeatedly returns to|often connects)\b/i,
  /^\s*coverage from\b.+\bplaces\b.+\bshowing that the subject is best understood through several complementary sources rather than a single account\b/i,
  /^\s*(?:overview|context|themes?|views?|perspectives?|foundations?|map)\b.+\bconnected to\b.+\bwithin the broader story of\b/i,
];
const PROMOTIONAL_NARRATIVE_PATTERNS = [
  /\bthrough our website\b/i,
  /\bon our website\b/i,
  /\bapply\b.{0,40}\b(?:online|website|form)\b/i,
  /\be-?visa\b/i,
  /\bwithout having to go\b/i,
  /\bin a convenient way\b/i,
  /\bon your own\b/i,
];
const GENERIC_SOURCE_SUBDOMAINS = new Set([
  "www",
  "en",
  "m",
  "mobile",
  "home",
  "docs",
  "support",
  "blog",
  "amp",
  "edition",
]);

type DefinitionLike = {
  term?: string | null;
  description?: string | null;
};

type SubTopicLike = {
  title?: string | null;
  summary?: string | null;
};

export interface ChapterNarrativePage {
  pageNumber: number;
  content: string;
  pageKind: "opening" | "analysis" | "synthesis";
}

export interface ChapterRenderPlan {
  chapter: Chapter;
  titlePageNumber: number;
  textPages: ChapterNarrativePage[];
  glossaryPageNumber: number;
  renderableDefinitions: Chapter["definitions"];
  renderableSubTopics: Chapter["subTopics"];
}

export interface NormalizedSourceLink {
  title: string;
  url: string;
  hostname: string;
  isSearchResultsPage: boolean;
}

function countDomainMentions(text: string): number {
  return text.match(DOMAINISH_PATTERN)?.length || 0;
}

function trimWrapperPunctuation(text: string): string {
  return text
    .replace(/^[\[\]{}()<>`"'|,:;_-]+/, "")
    .replace(/[\[\]{}()<>`"'|,:;_-]+$/, "")
    .trim();
}

function isLikelyStructuredArtifactLine(line: string): boolean {
  const normalized = line.trim();
  if (!normalized) return false;

  if (/^[ \t]*`{3}[a-z0-9_-]*[ \t]*$/i.test(normalized)) return true;
  if (STRUCTURED_EXPORT_HEADING_PATTERN.test(normalized) || EXPORT_METADATA_LINE_PATTERN.test(normalized)) return true;
  if (JSONISH_KEY_PATTERN.test(normalized)) return true;

  const jsonishFields = normalized.match(/"[^"]+"\s*:/g)?.length || 0;
  if ((normalized.startsWith("[") || normalized.startsWith("{")) && jsonishFields >= 1) return true;
  if (jsonishFields >= 2 && /[\[\]{}]/.test(normalized)) return true;
  if (/^[\[\]{},"':;]+$/.test(normalized)) return true;

  const domainMentions = countDomainMentions(normalized);
  if (domainMentions >= 2 && !/[.!?]/.test(normalized)) return true;
  if (BULLET_LINE_PATTERN.test(normalized) && (domainMentions > 0 || ISO_TIMESTAMP_PATTERN.test(normalized))) return true;
  if (domainMentions >= 1 && ISO_TIMESTAMP_PATTERN.test(normalized) && !/[.!?]$/.test(normalized)) return true;

  if (/\b(?:rel=["']nofollow|href=["']\/\/|<a\b|<\/a>)/i.test(normalized)) return true;

  return false;
}

function isLikelyStructuredArtifactParagraph(paragraph: string): boolean {
  const normalized = paragraph.replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  if (isLikelyStructuredArtifactLine(normalized)) return true;
  if (JSONISH_KEY_PATTERN.test(normalized)) return true;
  return countDomainMentions(normalized) >= 2 && !/[.!?]/.test(normalized);
}

function containsNarrativeJunk(text: string): boolean {
  return GENERIC_SYNTHESIS_SENTENCE_PATTERNS.some((pattern) => pattern.test(text))
    || PROMOTIONAL_NARRATIVE_PATTERNS.some((pattern) => pattern.test(text));
}

function stripInlineUrlArtifacts(text: string): string {
  return text
    .replace(/\[\d+(?:\s*,\s*\d+)*\]/g, " ")
    .replace(/\b(?:a\s+)?rel=["'][^"']*["']/gi, " ")
    .replace(/\bhref=["'][^"']*["']/gi, " ")
    .replace(URLISH_INLINE_PATTERN, " ")
    .replace(ISO_TIMESTAMP_GLOBAL_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeNarrativeParagraph(paragraph: string): string {
  const normalizedParagraph = paragraph.replace(/\s+/g, " ").trim();
  if (!normalizedParagraph) return "";

  const withoutInlineUrls = stripInlineUrlArtifacts(normalizedParagraph);
  const sentences = splitIntoSentences(withoutInlineUrls);
  const cleanedSentences = (sentences.length > 0 ? sentences : [withoutInlineUrls])
    .map((sentence) => trimWrapperPunctuation(sentence.replace(/\s+/g, " ").trim()))
    .filter(Boolean)
    .filter((sentence) => !containsNarrativeJunk(sentence))
    .filter((sentence) => !isLikelyStructuredArtifactLine(sentence))
    .filter((sentence) => !isLikelyStructuredArtifactParagraph(sentence));

  return joinSentences(cleanedSentences).trim();
}

export function sanitizeNarrativeText(text?: string | null): string {
  const raw = typeof text === "string" ? text.replace(/\r/g, "\n").trim() : "";
  if (!raw) {
    return "";
  }

  let cleaned = raw.replace(/^[ \t]*`{3}[a-z0-9_-]*[ \t]*$/gim, "").trim();
  const structuredSectionIndex = cleaned.search(
    /(?:^|\n)\s*(?:VISUAL CONCEPT|CORE CONCEPTS|SUB-TOPICS|SOURCES|DEFINITIONS|GLOSSARY|TECHNICAL GLOSSARY)\s*:\s*(?:\n|$)/i
  );
  if (structuredSectionIndex >= 0) {
    cleaned = cleaned.slice(0, structuredSectionIndex).trim();
  }

  const filteredLines: string[] = [];
  for (const line of cleaned.split("\n")) {
    const normalizedLine = line.trim();
    if (!normalizedLine) {
      if (filteredLines.length > 0 && filteredLines[filteredLines.length - 1] !== "") {
        filteredLines.push("");
      }
      continue;
    }

    if (isLikelyStructuredArtifactLine(normalizedLine)) {
      continue;
    }

    filteredLines.push(normalizedLine);
  }

  const paragraphs = filteredLines
    .join("\n")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim())
    .map((paragraph) => sanitizeNarrativeParagraph(paragraph))
    .filter(Boolean)
    .filter((paragraph) => !isLikelyStructuredArtifactParagraph(paragraph));

  return trimWrapperPunctuation(paragraphs.join("\n\n")).replace(/\n{3,}/g, "\n\n").trim();
}

function sanitizeInlineText(text?: string | null): string {
  return sanitizeNarrativeText(text).replace(/\s+/g, " ").trim();
}

export function sanitizeStructuredLabel(text?: string | null, fallback = ""): string {
  const raw = typeof text === "string" ? text.replace(/\r/g, " ").replace(/\s+/g, " ").trim() : "";
  const normalized = trimWrapperPunctuation(
    raw
      .replace(/^[ \t]*`{3}[a-z0-9_-]*[ \t]*/i, "")
      .replace(/[ \t]*`{3}$/i, "")
  );
  const candidate = normalized || sanitizeInlineText(raw);

  if (!candidate) return fallback.trim();
  if (STRUCTURED_EXPORT_HEADING_PATTERN.test(candidate) || EXPORT_METADATA_LINE_PATTERN.test(candidate)) {
    return fallback.trim();
  }
  if (JSONISH_KEY_PATTERN.test(candidate) || isLikelyStructuredArtifactLine(candidate)) {
    return fallback.trim();
  }
  if (countDomainMentions(candidate) > 0 && candidate.length < 120) {
    return fallback.trim();
  }
  if ((!/[a-z0-9]/i.test(candidate) && !CJK_CHAR_PATTERN.test(candidate)) || candidate.length === 1) {
    return fallback.trim();
  }

  return clipLabelAtWordBoundary(candidate, 160).trim() || fallback.trim();
}

function sanitizeChapterForPresentation(chapter: Chapter, index: number, topic = ""): Chapter {
  const fallbackTitle = `Chapter ${index + 1}`;
  const safeTopic = sanitizeStructuredLabel(topic, "knowledge") || "knowledge";
  const rawTitle = sanitizeStructuredLabel(chapter?.title, fallbackTitle) || fallbackTitle;
  const strippedTitle = rawTitle
    .replace(/^(?:Chapter\s+\d+|第\s*[0-9一二三四五六七八九十百]+\s*[章节節部分]|\d+)\s*[:：\-–—]\s*/i, "")
    .trim();
  const title = strippedTitle || fallbackTitle;
  const rawContent = sanitizeNarrativeText(cleanChapterContent(chapter?.content || "", title));
  const definitions = Array.isArray(chapter?.definitions)
    ? dedupeByLabel(
      chapter.definitions
        .map((definition) => ({
          ...definition,
          term: cleanTermLabel(sanitizeStructuredLabel(definition?.term, "")),
          description: sanitizeInlineText(cleanChapterContent(definition?.description || "")),
        }))
        .filter((definition) => definition.term && definition.description),
      (definition) => definition.term
    )
    : [];
  const subTopics = Array.isArray(chapter?.subTopics)
    ? dedupeByLabel(
      chapter.subTopics
        .map((subTopic) => ({
          ...subTopic,
          title: cleanTermLabel(sanitizeStructuredLabel(subTopic?.title, "")),
          summary: sanitizeInlineText(cleanChapterContent(subTopic?.summary || "")),
        }))
        .filter((subTopic) => subTopic.title && subTopic.summary),
      (subTopic) => subTopic.title
    )
    : [];
  // The glossary and the sub-topic list are printed as their own sections; the body must not say the same thing again.
  const content = removeRepeatedSections(rawContent, definitions, subTopics);
  const visualSeed = localizeVisualSeed(
    sanitizeStructuredLabel(chapter?.visualSeed, title || safeTopic) || safeTopic,
    { title, sample: content.slice(0, 1500) }
  );
  const sourceUrls = Array.isArray(chapter?.sourceUrls)
    ? chapter.sourceUrls
      .map((source) => {
        const rawUrl = typeof source === "string" ? source.trim() : source?.url?.trim();
        if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) {
          return null;
        }

        try {
          const u = new URL(rawUrl);
          const cleanHost = u.hostname.toLowerCase();
          if (cleanHost.includes('source-') || cleanHost === 'knowledge-base.org' || cleanHost === 'localhost') {
            return null;
          }
          if (typeof source === "string") {
            return rawUrl;
          }
          return {
            title: sanitizeStructuredLabel(source.title, rawUrl),
            url: rawUrl,
          };
        } catch {
          return null;
        }
      })
      .filter((source): source is Chapter["sourceUrls"][number] => Boolean(source))
    : [];

  return {
    title,
    content,
    definitions,
    subTopics,
    sourceUrls,
    visualSeed,
  };
}

export function sanitizeWebBookForPresentation(webBook: WebBook): WebBook {
  const topic = sanitizeStructuredLabel(webBook?.topic, "Untitled WebBook") || "Untitled WebBook";
  const chapters = Array.isArray(webBook?.chapters)
    ? webBook.chapters
      .map((chapter, index) => sanitizeChapterForPresentation(chapter, index, topic))
      .filter((chapter) => chapter.content || chapter.definitions.length > 0 || chapter.subTopics.length > 0)
    : [];

  return {
    ...webBook,
    topic,
    chapters,
  };
}

function normalizeChapterForRender(chapter: Chapter, index: number): Chapter {
  const sanitizedChapter = sanitizeChapterForPresentation(chapter, index);
  return {
    title: sanitizedChapter.title || "Untitled Chapter",
    content: sanitizedChapter.content || "",
    definitions: sanitizedChapter.definitions || [],
    subTopics: sanitizedChapter.subTopics || [],
    sourceUrls: sanitizedChapter.sourceUrls || [],
    visualSeed: sanitizedChapter.visualSeed || "knowledge",
  };
}

export function isMeaningfulText(text?: string | null, description = ""): boolean {
  if (!text) return false;

  const normalizedText = text.trim();
  const normalizedDescription = description.trim();
  if (!normalizedText) return false;

  const clean = normalizedText.replace(/\s/g, "");
  const lowerText = normalizedText.toLowerCase();
  const lowerDesc = normalizedDescription.toLowerCase();

  const cjkMatches = clean.match(/[\u1100-\u11ff\u2e80-\ua4cf\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/g);
  const isCjk = cjkMatches ? cjkMatches.length >= 2 : false;

  if (/^\d+$/.test(clean)) return false;
  if (/(.)\1{8,}/.test(clean)) return false;
  if (/\d{10,}/.test(clean)) return false;
  if (!isCjk && normalizedText.length > 40 && !normalizedText.includes(" ")) return false;
  if (!isCjk && clean.length > 12 && !/[aeiou]/i.test(clean)) return false;

  const parts = clean.split(/[-_]/);
  if (parts.length > 3) {
    const uniqueParts = new Set(parts);
    if (uniqueParts.size < parts.length / 2) return false;
  }

  if (clean.includes("TCXGSD") && clean.length > 30) {
    const tcxCount = (clean.match(/TCXGSD/g) || []).length;
    if (tcxCount > 2) return false;
  }

  if (REPEATED_SUBSTRING_PATTERN.test(clean)) return false;
  if (containsPoisonBoilerplate(normalizedText, normalizedDescription)) return false;
  if (normalizedDescription.length > 1000) return false;

  const words = lowerText
    .split(/\s+/)
    .concat(lowerDesc.split(/\s+/))
    .filter((word) => word.length > 0);

  if (words.length > 30) {
    const uniqueWords = new Set(words);
    const uniqueRatio = uniqueWords.size / words.length;
    if (uniqueRatio < 0.35) return false;

    const andItsCount = (lowerText.match(/and its/g) || []).length + (lowerDesc.match(/and its/g) || []).length;
    const andOurCount = (lowerText.match(/and our/g) || []).length + (lowerDesc.match(/and our/g) || []).length;
    const andTheCount = (lowerText.match(/and the/g) || []).length + (lowerDesc.match(/and the/g) || []).length;
    const andAllCount = (lowerText.match(/and all/g) || []).length + (lowerDesc.match(/and all/g) || []).length;
    if (andItsCount > 4 || andOurCount > 4 || andTheCount > 8 || andAllCount > 4) return false;

    for (let i = 0; i < words.length - 1; i += 1) {
      const phrase = `${words[i]} ${words[i + 1]}`;
      if (phrase.length < 12) continue;

      let count = 0;
      for (let j = 0; j < words.length - 1; j += 1) {
        if (`${words[j]} ${words[j + 1]}` === phrase) {
          count += 1;
        }
      }

      if (count > 3) return false;
    }
  }

  if (looksLikeAssemblyCode(normalizedText) || looksLikeAssemblyCode(normalizedDescription)) return false;
  if (/[0-9a-f]{2,}\s[0-9a-f]{2,}\s[0-9a-f]{2,}/i.test(normalizedText)) return false;

  return true;
}

export function getRenderableDefinitions<T extends DefinitionLike>(definitions: T[] = [], maxItems = Number.POSITIVE_INFINITY): T[] {
  const seenTerms = new Set<string>();

  return definitions
    .filter((definition) => {
      const term = definition.term?.trim() || "";
      const description = definition.description?.trim() || "";
      if (!term || !description) return false;

      const termKey = term.toLowerCase();
      if (seenTerms.has(termKey)) return false;
      if (!isMeaningfulText(term, description)) return false;

      seenTerms.add(termKey);
      return true;
    })
    .slice(0, maxItems);
}

export function getRenderableSubTopics<T extends SubTopicLike>(subTopics: T[] = []): T[] {
  const seenTitles = new Set<string>();

  return subTopics.filter((subTopic) => {
    const title = subTopic.title?.trim() || "";
    const summary = subTopic.summary?.trim() || "";
    if (!title || !summary) return false;

    const titleKey = title.toLowerCase();
    if (seenTitles.has(titleKey)) return false;
    if (!isMeaningfulText(title, summary)) return false;

    seenTitles.add(titleKey);
    return true;
  });
}

export function joinSentences(sentences: string[]): string {
  return sentences.reduce((accumulator, sentence, index) => {
    if (index === 0) return sentence;
    const previous = sentences[index - 1];
    const separator = CJK_SENTENCE_END_PATTERN.test(previous) ? "" : " ";
    return `${accumulator}${separator}${sentence}`;
  }, "");
}

function splitParagraphIntoTwo(paragraph: string): string[] {
  const normalized = paragraph.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return [];
  }

  const sentences = splitIntoSentences(normalized);
  if (sentences.length >= 4) {
    const midpoint = Math.ceil(sentences.length / 2);
    return [
      joinSentences(sentences.slice(0, midpoint)).trim(),
      joinSentences(sentences.slice(midpoint)).trim(),
    ].filter(Boolean);
  }

  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length >= 30) {
    const midpoint = Math.ceil(words.length / 2);
    return [
      words.slice(0, midpoint).join(" ").trim(),
      words.slice(midpoint).join(" ").trim(),
    ].filter(Boolean);
  }

  return [normalized];
}

function ensureMinimumParagraphs(paragraphs: string[], minimumParagraphs: number): string[] {
  const result = paragraphs
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  let safetyCounter = 0;
  while (result.length < minimumParagraphs && safetyCounter < 16) {
    safetyCounter += 1;

    let longestIndex = -1;
    let longestWordCount = -1;

    result.forEach((paragraph, index) => {
      const wordCount = countWords(paragraph);
      if (wordCount > longestWordCount) {
        longestWordCount = wordCount;
        longestIndex = index;
      }
    });

    if (longestIndex === -1) {
      break;
    }

    const splitParagraph = splitParagraphIntoTwo(result[longestIndex]);
    if (splitParagraph.length < 2) {
      break;
    }

    result.splice(longestIndex, 1, ...splitParagraph);
  }

  return result;
}

function normalizeChapterParagraphs(content: string, minimumParagraphs = MIN_CHAPTER_TEXT_PAGES): string[] {
  const normalized = content.replace(/\r/g, "").trim();
  if (!normalized) {
    return [];
  }

  const explicitParagraphs = normalized
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  if (explicitParagraphs.length >= minimumParagraphs) {
    return ensureMinimumParagraphs(explicitParagraphs, minimumParagraphs);
  }

  if (explicitParagraphs.length > 1) {
    return ensureMinimumParagraphs(explicitParagraphs, minimumParagraphs);
  }

  const sentences = splitIntoSentences(normalized);
  if (sentences.length === 0) {
    return [normalized];
  }

  const paragraphTarget = Math.max(6, Math.min(9, Math.ceil(sentences.length / 2)));
  const groupSize = Math.max(2, Math.ceil(sentences.length / paragraphTarget));
  const generatedParagraphs: string[] = [];

  for (let index = 0; index < sentences.length; index += groupSize) {
    generatedParagraphs.push(joinSentences(sentences.slice(index, index + groupSize)).trim());
  }

  return ensureMinimumParagraphs(generatedParagraphs, minimumParagraphs);
}

/**
 * Splits a chapter into narrative pages. The page count follows the amount of real text: a chapter never gets a page
 * it has no new text for, and no paragraph is ever repeated to fill one.
 *  - Snippet-only books (no Gemini key) get as many pages as their text fills at TARGET_WORDS_PER_TEXT_PAGE, 1..3.
 *  - Gemini-written books aim for MIN_CHAPTER_TEXT_PAGES, but fall back to fewer pages if the text cannot be split
 *    into that many distinct paragraphs.
 */
function buildNarrativePageContents(content: string, snippetOnly = false): string[] {
  const requestedPages = snippetOnly ? 1 : MIN_CHAPTER_TEXT_PAGES;
  const paragraphs = normalizeChapterParagraphs(content, requestedPages);
  if (paragraphs.length === 0) {
    return [];
  }

  const totalWords = paragraphs.reduce((sum, paragraph) => sum + countWords(paragraph), 0);
  const wantedPages = snippetOnly
    ? Math.max(1, Math.min(MIN_CHAPTER_TEXT_PAGES, Math.round(totalWords / TARGET_WORDS_PER_TEXT_PAGE)))
    : MIN_CHAPTER_TEXT_PAGES;
  const pageCount = Math.max(1, Math.min(wantedPages, paragraphs.length));
  const balancedParagraphs = ensureMinimumParagraphs(paragraphs, pageCount);
  const targetWords = Math.max(1, Math.ceil(totalWords / pageCount));
  const pages = Array.from({ length: pageCount }, () => [] as string[]);

  let pageIndex = 0;
  let currentPageWords = 0;

  for (let index = 0; index < balancedParagraphs.length; index += 1) {
    const paragraph = balancedParagraphs[index];
    const words = countWords(paragraph);
    const paragraphsRemaining = balancedParagraphs.length - index;
    const pagesRemaining = pageCount - pageIndex;

    if (
      pageIndex < pageCount - 1 &&
      pages[pageIndex].length > 0 &&
      (currentPageWords >= targetWords || paragraphsRemaining <= pagesRemaining - 1)
    ) {
      pageIndex += 1;
      currentPageWords = 0;
    }

    pages[pageIndex].push(paragraph);
    currentPageWords += words;
  }

  // Empty pages are dropped, never filled with a copy of another paragraph.
  return pages.filter((page) => page.length > 0).map((page) => page.join("\n\n"));
}

export function buildChapterRenderPlan(
  chapters: Chapter[],
  options: { sourceMode?: WebBookSourceMode } = {}
): ChapterRenderPlan[] {
  const snippetOnly = isSnippetOnlySourceMode(options.sourceMode);
  const safeChapters = Array.isArray(chapters) ? chapters.map((chapter, index) => normalizeChapterForRender(chapter, index)) : [];
  let nextPageNumber = 3;
  const pageKinds: ChapterNarrativePage["pageKind"][] = ["opening", "analysis", "synthesis"];

  return safeChapters.map((chapter) => {
    const renderableDefinitions = getRenderableDefinitions(chapter.definitions || [], 8);
    const renderableSubTopics = getRenderableSubTopics(chapter.subTopics || []).slice(0, 4);
    const textPageContents = buildNarrativePageContents(chapter.content, snippetOnly);
    const titlePageNumber = nextPageNumber;
    const textPages = textPageContents.map((content, index) => ({
      pageNumber: titlePageNumber + index,
      content,
      pageKind: pageKinds[index] || "synthesis",
    }));

    nextPageNumber += textPages.length;
    const glossaryPageNumber = nextPageNumber;
    nextPageNumber += 1;

    return {
      chapter,
      titlePageNumber,
      textPages,
      glossaryPageNumber,
      renderableDefinitions,
      renderableSubTopics,
    };
  });
}

function buildReadableSourceTitle(url: URL): string {
  const hostname = url.hostname.replace(/^www\./, "");
  const parts = hostname
    .split(".")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  const meaningfulParts = parts.filter((part, index) => (
    index === parts.length - 1 || !GENERIC_SOURCE_SUBDOMAINS.has(part)
  ));
  const label = meaningfulParts.length >= 2
    ? meaningfulParts[meaningfulParts.length - 2]
    : meaningfulParts[0] || parts[0] || hostname;

  return label.replace(/[-_]/g, " ").trim() || hostname;
}

function isSearchResultsPage(url: URL): boolean {
  const hostname = url.hostname.replace(/^www\./, "");
  return (
    ((hostname === "google.com" || hostname.endsWith(".google.com")) && url.pathname === "/search") ||
    (hostname === "duckduckgo.com" && (url.pathname === "/" || url.pathname === "/html/" || url.pathname === "/html" || url.pathname === "/lite/" || url.pathname === "/lite"))
  );
}

export function normalizeSourceLink(source: Chapter["sourceUrls"][number]): NormalizedSourceLink | null {
  const rawUrl = typeof source === "string" ? source : source.url;
  if (!rawUrl) return null;

  try {
    const url = new URL(rawUrl);
    if (!/^https?:$/.test(url.protocol)) {
      return null;
    }

    const cleanHost = url.hostname.toLowerCase();
    if (cleanHost.includes('source-') || cleanHost === 'knowledge-base.org' || cleanHost === 'localhost') {
      return null;
    }

    const rawTitle = typeof source === "string" ? "" : (source.title?.trim() || "");
    const title = !rawTitle
      || rawTitle === url.toString()
      || /^https?:\/\//i.test(rawTitle)
      || /^www\./i.test(rawTitle)
      ? buildReadableSourceTitle(url)
      : rawTitle;

    return {
      title,
      url: url.toString(),
      hostname: url.hostname.replace(/^www\./, ""),
      isSearchResultsPage: isSearchResultsPage(url),
    };
  } catch {
    return null;
  }
}

export function getChapterSourceLinks(
  chapter: Chapter,
  options: { includeSearchResults?: boolean; maxItems?: number } = {}
): NormalizedSourceLink[] {
  const { includeSearchResults = true, maxItems = Number.POSITIVE_INFINITY } = options;
  const links: NormalizedSourceLink[] = [];

  const sourceUrls = Array.isArray(chapter?.sourceUrls) ? chapter.sourceUrls : [];

  sourceUrls.forEach((source) => {
    const normalized = normalizeSourceLink(source);
    if (!normalized) return;
    if (!includeSearchResults && normalized.isSearchResultsPage) return;
    if (links.some((existing) => existing.url === normalized.url)) return;

    links.push(normalized);
  });

  return links.slice(0, maxItems);
}

export function reduceRepeatedChapterSourceReferences(chapters: WebBook["chapters"]): WebBook["chapters"] {
  const usedUrls = new Set<string>();

  return chapters.map((chapter) => {
    const sourceUrls = Array.isArray(chapter.sourceUrls) ? chapter.sourceUrls : [];
    const seenWithinChapter = new Set<string>();
    const novelSources: typeof sourceUrls = [];
    const fallbackSources: typeof sourceUrls = [];

    sourceUrls.forEach((source) => {
      const url = typeof source === "string" ? source.trim() : source?.url?.trim();
      if (!url || seenWithinChapter.has(url)) {
        return;
      }

      seenWithinChapter.add(url);
      if (usedUrls.has(url)) {
        fallbackSources.push(source);
        return;
      }

      novelSources.push(source);
    });

    const dedupedSourceUrls = novelSources.length > 0 ? novelSources : fallbackSources.slice(0, 1);
    dedupedSourceUrls.forEach((source) => {
      const url = typeof source === "string" ? source.trim() : source?.url?.trim();
      if (url) {
        usedUrls.add(url);
      }
    });

    return {
      ...chapter,
      sourceUrls: dedupedSourceUrls,
    };
  });
}
