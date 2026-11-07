const SEARCH_EXTRACTION_ARRAY_KEYS = ['results', 'sources', 'items', 'pages', 'documents', 'entries'] as const;
const SEARCH_EXTRACTION_ITEM_TAGS = ['source', 'result', 'item', 'entry', 'page', 'document', 'article', 'record'];
const SEARCH_EXTRACTION_TITLE_TAGS = ['title', 'headline', 'name', 'heading', 'h1', 'h2', 'h3'];
const SEARCH_EXTRACTION_CONTENT_TAGS = ['content', 'summary', 'snippet', 'description', 'body', 'text', 'excerpt', 'abstract'];
const SEARCH_EXTRACTION_URL_TAGS = ['url', 'link', 'uri', 'href', 'canonical'];
const RAW_TEXT_LABEL_PATTERN = '[A-Za-z][A-Za-z0-9 _-]{1,40}';

function normalizePopulationText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function sanitizeSourceTitle(title: string): string {
  return title
    .replace(/\s+/g, ' ')
    .replace(/^(?:(?:\[(?:pdf|doc|docs|docx|docss)\]|\((?:pdf|doc|docs|docx|docss)\)|(?:pdf|doc|docs|docx|docss)\b)\s*[-:|]?\s*)+/i, '')
    .trim();
}

function repairTruncatedJSON(jsonString: string): string {
  const attemptRepair = (input: string) => {
    const stack: string[] = [];
    let inString = false;
    let escaped = false;

    for (let index = 0; index < input.length; index += 1) {
      const char = input[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (char === '{' || char === '[') {
        stack.push(char);
      } else if (char === '}' || char === ']') {
        const last = stack[stack.length - 1];
        if ((char === '}' && last === '{') || (char === ']' && last === '[')) {
          stack.pop();
        }
      }
    }

    let repaired = input;
    if (inString) repaired += '"';
    while (stack.length > 0) {
      const last = stack.pop();
      repaired += last === '{' ? '}' : ']';
    }
    return repaired;
  };

  const firstTry = attemptRepair(jsonString);
  try {
    JSON.parse(firstTry);
    return firstTry;
  } catch {
    let lastComma = jsonString.lastIndexOf(',');
    while (lastComma > 0) {
      const secondTry = attemptRepair(jsonString.substring(0, lastComma));
      try {
        JSON.parse(secondTry);
        return secondTry;
      } catch {
        lastComma = jsonString.lastIndexOf(',', lastComma - 1);
      }
    }
  }

  return firstTry;
}

function stripStructuredResponseFence(rawText: string): string {
  const cleanText = rawText.trim();
  const fencedMatch = cleanText.match(/^```(?:[a-z0-9_-]+)?\s*[\r\n]+([\s\S]*?)\s*```$/i);
  return fencedMatch?.[1]?.trim() || cleanText;
}

export function tryParseLooseJson(rawText: string): unknown | null {
  const cleanText = stripStructuredResponseFence(rawText);

  try {
    return JSON.parse(cleanText) as unknown;
  } catch {
    try {
      return JSON.parse(repairTruncatedJSON(cleanText)) as unknown;
    } catch {
      return null;
    }
  }
}

function decodeNumericEntity(value: string, radix: number): string {
  const parsedValue = Number.parseInt(value, radix);
  if (!Number.isFinite(parsedValue)) {
    return '';
  }

  try {
    return String.fromCodePoint(parsedValue);
  } catch {
    return '';
  }
}

function decodeStructuredText(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, value: string) => decodeNumericEntity(value, 16))
    .replace(/&#([0-9]+);/g, (_, value: string) => decodeNumericEntity(value, 10))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/(?:&apos;|&#39;)/gi, "'");
}

function stripMarkup(text: string): string {
  return normalizePopulationText(
    decodeStructuredText(text)
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<(?:br|hr)\b[^>]*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|section|article|li|tr|td|th|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  );
}

function extractTaggedInnerText(rawText: string, tagNames: readonly string[]): string {
  for (const tagName of tagNames) {
    const match = rawText.match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i'));
    if (match?.[1]) {
      const normalized = stripMarkup(match[1]);
      if (normalized) {
        return normalized;
      }
    }
  }

  return '';
}

function extractCanonicalUrl(rawText: string): string {
  const matches = [
    rawText.match(/<link\b[^>]*rel=["'][^"']*canonical[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>/i),
    rawText.match(/<meta\b[^>]*(?:property|name)=["']og:url["'][^>]*content=["']([^"']+)["'][^>]*>/i),
    rawText.match(/<meta\b[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']og:url["'][^>]*>/i),
    rawText.match(/\bhref\s*=\s*["'](https?:\/\/[^"']+)["']/i),
    rawText.match(/\b(?:url|link|uri)\s*=\s*["'](https?:\/\/[^"']+)["']/i),
    rawText.match(/https?:\/\/[^\s"'<>]+/i),
  ];

  for (const match of matches) {
    const candidate = decodeStructuredText(match?.[1] || match?.[0] || '').replace(/[),.;]+$/, '').trim();
    if (candidate) {
      return candidate;
    }
  }

  return '';
}

function extractNumericScore(rawText: string, labels: readonly string[]): number | undefined {
  for (const label of labels) {
    const tagMatch = extractTaggedInnerText(rawText, [label]);
    if (tagMatch) {
      const parsed = Number.parseFloat(tagMatch);
      if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) {
        return parsed;
      }
    }

    const inlineMatch = rawText.match(new RegExp(`${label}\\s*[:=]\\s*(-?\\d+(?:\\.\\d+)?)`, 'i'));
    if (inlineMatch?.[1]) {
      const parsed = Number.parseFloat(inlineMatch[1]);
      if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) {
        return parsed;
      }
    }
  }

  return undefined;
}

function extractStructuredPairs(
  rawText: string,
  itemTags: readonly string[],
  labelTags: readonly string[],
  valueTags: readonly string[],
  sourceUrl: string,
  kind: 'definition' | 'subTopic'
): any[] {
  const pairs: any[] = [];

  for (const itemTag of itemTags) {
    const pattern = new RegExp(`<${itemTag}\\b[^>]*>([\\s\\S]*?)<\\/${itemTag}>`, 'gi');
    for (const match of rawText.matchAll(pattern)) {
      const itemBody = match[1] || '';
      const label = extractTaggedInnerText(itemBody, labelTags);
      const value = extractTaggedInnerText(itemBody, valueTags);
      if (!label || !value) {
        continue;
      }

      pairs.push(kind === 'definition'
        ? { term: label, description: value, sourceUrl }
        : { title: label, summary: value, sourceUrl });
    }
  }

  return pairs;
}

function extractLabeledSection(rawText: string, labels: readonly string[]): string {
  for (const label of labels) {
    const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = rawText.match(
      new RegExp(`(?:^|\\n)\\s*${escapedLabel}\\s*:\\s*([\\s\\S]*?)(?=\\n\\s*${RAW_TEXT_LABEL_PATTERN}\\s*:|$)`, 'i')
    );
    if (match?.[1]) {
      const normalized = decodeStructuredText(match[1]).trim();
      if (normalized) {
        return normalized;
      }
    }
  }

  return '';
}

function extractLabeledValue(rawText: string, labels: readonly string[]): string {
  for (const label of labels) {
    const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = rawText.match(new RegExp(`(?:^|\\n)\\s*${escapedLabel}\\s*:\\s*(.+)$`, 'im'));
    if (match?.[1]) {
      const normalized = decodeStructuredText(match[1]).trim();
      if (normalized) {
        return normalized;
      }
    }
  }

  return '';
}

function buildSyntheticSearchIntakeUrl(index: number): string {
  return `search-intake://source/${index + 1}`;
}

function parseRawLinePairs(
  sectionText: string,
  kind: 'definition' | 'subTopic',
  sourceUrl: string
): any[] {
  return sectionText
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean)
    .reduce<any[]>((pairs, line) => {
      const separatorIndex = line.indexOf(':');
      if (separatorIndex <= 0) {
        return pairs;
      }

      const label = line.slice(0, separatorIndex).trim();
      const value = line.slice(separatorIndex + 1).trim();
      if (!label || !value) {
        return pairs;
      }

      pairs.push(kind === 'definition'
        ? { term: label, description: value, sourceUrl }
        : { title: label, summary: value, sourceUrl });
      return pairs;
    }, []);
}

function buildSearchExtractionCandidate(
  candidate: {
    url?: string;
    title?: string;
    content?: string;
    definitions?: any[];
    subTopics?: any[];
    informativeScore?: number;
    authorityScore?: number;
  },
  index: number
): any | null {
  const url = (candidate.url || '').trim() || buildSyntheticSearchIntakeUrl(index);
  const title = sanitizeSourceTitle((candidate.title || '').trim()) || `Search Intake Source ${index + 1}`;
  const content = normalizePopulationText(candidate.content || '');

  if (!content) {
    return null;
  }

  return {
    url,
    title,
    content,
    definitions: Array.isArray(candidate.definitions) ? candidate.definitions : [],
    subTopics: Array.isArray(candidate.subTopics) ? candidate.subTopics : [],
    informativeScore: candidate.informativeScore,
    authorityScore: candidate.authorityScore,
  };
}

function parseSearchExtractionMarkup(rawText: string): any[] {
  const itemMatches = SEARCH_EXTRACTION_ITEM_TAGS.flatMap((tagName) => (
    Array.from(rawText.matchAll(new RegExp(`<${tagName}\\b[^>]*>[\\s\\S]*?<\\/${tagName}>`, 'gi')))
      .map((match) => match[0])
  ));
  const uniqueItems = Array.from(new Set(itemMatches));

  const structuredItems = uniqueItems
    .map((item, index) => {
      const url = extractTaggedInnerText(item, SEARCH_EXTRACTION_URL_TAGS) || extractCanonicalUrl(item);
      const content = extractTaggedInnerText(item, SEARCH_EXTRACTION_CONTENT_TAGS) || stripMarkup(item);
      return buildSearchExtractionCandidate({
        url,
        title: extractTaggedInnerText(item, SEARCH_EXTRACTION_TITLE_TAGS),
        content,
        definitions: extractStructuredPairs(item, ['definition'], ['term', 'name', 'label', 'title'], ['description', 'summary', 'meaning', 'text', 'content'], url, 'definition'),
        subTopics: extractStructuredPairs(item, ['subtopic'], ['title', 'name', 'heading'], ['summary', 'description', 'text', 'content'], url, 'subTopic'),
        informativeScore: extractNumericScore(item, ['informativeScore', 'informative_score']),
        authorityScore: extractNumericScore(item, ['authorityScore', 'authority_score']),
      }, index);
    })
    .filter((item): item is any => Boolean(item));

  if (structuredItems.length > 0) {
    return structuredItems;
  }

  if (!/<[a-z][\s\S]*>/i.test(rawText)) {
    return [];
  }

  const singleUrl = extractCanonicalUrl(rawText);
  const singleContent = extractTaggedInnerText(rawText, ['article', 'body']) || stripMarkup(rawText);
  const singleCandidate = buildSearchExtractionCandidate({
    url: singleUrl,
    title: extractTaggedInnerText(rawText, ['title', 'h1']),
    content: singleContent,
    informativeScore: extractNumericScore(rawText, ['informativeScore', 'informative_score']),
    authorityScore: extractNumericScore(rawText, ['authorityScore', 'authority_score']),
  }, 0);

  return singleCandidate ? [singleCandidate] : [];
}

function splitRawSearchBlocks(rawText: string): string[] {
  const normalized = rawText.replace(/\r/g, '').trim();
  if (!normalized) {
    return [];
  }

  const urlLabelMatches = Array.from(normalized.matchAll(/(?:^|\n)\s*(?:url|link|uri)\s*:\s*https?:\/\/[^\s]+/gim));
  if (urlLabelMatches.length >= 2) {
    return urlLabelMatches.map((match, index) => {
      const start = match.index || 0;
      const end = index + 1 < urlLabelMatches.length ? (urlLabelMatches[index + 1].index || normalized.length) : normalized.length;
      return normalized.slice(start, end).trim();
    }).filter(Boolean);
  }

  return [normalized];
}

function parseSearchExtractionRawText(rawText: string): any[] {
  return splitRawSearchBlocks(rawText)
    .map((block, index) => {
      // Strip any residual markdown code-fence marker lines (e.g. ```json or ```)
      // that stripStructuredResponseFence may have missed when trailing content
      // follows the closing fence, preventing them from leaking into titles or content.
      const cleanBlock = block.replace(/^[ \t]*`{3}[a-z0-9_-]*[ \t]*$/gim, '').trim();
      const url = extractLabeledValue(cleanBlock, ['url', 'link', 'uri']) || extractCanonicalUrl(cleanBlock);
      const title = extractLabeledValue(cleanBlock, ['title', 'headline', 'name'])
        || cleanBlock
          .split('\n')
          .map((line) => line.trim())
          .find((line) => (
            line.length > 0
            && !/^(?:url|link|uri|content|summary|snippet|description|body|text|excerpt|definitions?|glossary|subtopics?|sub-topics?|topics|informative(?:\s+|_)?score|authority(?:\s+|_)?score)\s*:/i.test(line)
            && !/^https?:\/\//i.test(line)
          ))
        || '';
      const definitionSourceUrl = /^https?:\/\//i.test(url) ? url : '';
      const content = extractLabeledSection(cleanBlock, ['content', 'summary', 'snippet', 'description', 'body', 'text', 'excerpt'])
        || normalizePopulationText(
          cleanBlock
            .split('\n')
            .filter((line) => !/^\s*(?:url|link|uri|title|headline|name|informative(?:\s+|_)?score|authority(?:\s+|_)?score)\s*:/i.test(line))
            .join(' ')
        );

      return buildSearchExtractionCandidate({
        url,
        title,
        content,
        definitions: parseRawLinePairs(extractLabeledSection(cleanBlock, ['definitions', 'glossary']), 'definition', definitionSourceUrl),
        subTopics: parseRawLinePairs(extractLabeledSection(cleanBlock, ['subtopics', 'sub-topics', 'topics']), 'subTopic', definitionSourceUrl),
        informativeScore: extractNumericScore(cleanBlock, ['informativeScore', 'informative score']),
        authorityScore: extractNumericScore(cleanBlock, ['authorityScore', 'authority score']),
      }, index);
    })
    .filter((item): item is any => Boolean(item));
}

export function parseSearchExtractionResponse(rawText: string, fallbackMessage: string): any[] {
  const parsedJson = tryParseLooseJson(rawText);
  if (Array.isArray(parsedJson)) {
    return parsedJson;
  }

  if (parsedJson && typeof parsedJson === 'object') {
    for (const key of SEARCH_EXTRACTION_ARRAY_KEYS) {
      const candidate = (parsedJson as Record<string, unknown>)[key];
      if (Array.isArray(candidate)) {
        return candidate;
      }
    }
  }

  const cleanText = stripStructuredResponseFence(rawText);
  const parsedMarkup = parseSearchExtractionMarkup(cleanText);
  if (parsedMarkup.length > 0) {
    return parsedMarkup;
  }

  const rawTextPayload = /<[^>]+>/.test(cleanText) ? stripMarkup(cleanText) : cleanText;
  const parsedRawText = parseSearchExtractionRawText(rawTextPayload);
  if (parsedRawText.length > 0) {
    return parsedRawText;
  }

  console.error('Failed to parse search extraction response:', rawText);
  throw new Error(fallbackMessage);
}
