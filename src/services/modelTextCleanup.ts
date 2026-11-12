// Clean-up of text written by (mostly small, local) models. The book renderers print plain text, so Markdown the model adds on its
// own ("## 第一章：...", "**term:**", "### heading") would show as literal symbols, and a dropped ")" leaves "(Reform Dilemma:" open.

/** Number of chapters a book has. The outline prompt asks for this many and anything beyond is dropped. */
export const BOOK_CHAPTER_COUNT = 10;

const HEADING_LINE = /^\s{0,3}#{1,6}\s*(.*)$/;

/** Strips emphasis markers (**bold**, __bold__, a lone leftover **) from a single line of text. */
export function stripMarkdownInline(text: string): string {
  return String(text ?? '')
    .replace(/\*\*\*?([^*\n]+?)\*\*\*?/g, '$1')
    .replace(/__([^_\n]+?)__/g, '$1')
    .replace(/\*\*+/g, '')
    .replace(/`+/g, '');
}

/** Adds the closing bracket the model left out ("(Reform Dilemma" becomes "(Reform Dilemma)"). Full-width brackets are handled too. */
export function balanceBrackets(text: string): string {
  const pairs: Array<[string, string]> = [['(', ')'], ['（', '）']];
  let out = String(text ?? '').trim().replace(/[:：]\s*$/, '');
  for (const [open, close] of pairs) {
    const missing = out.split(open).length - out.split(close).length;
    if (missing > 0) out += close.repeat(missing);
  }
  return out;
}

/** A defined term or sub-topic title: one line, no Markdown, balanced brackets. */
export function cleanTermLabel(text: string): string {
  return balanceBrackets(stripMarkdownInline(text).replace(/^\s*[-*•]\s+/, '').replace(/\s+/g, ' ').trim());
}

/**
 * Chapter body: removes Markdown heading markers and emphasis. A heading line that only repeats the chapter title (the models
 * number these wrongly, e.g. "## 第六章：..." inside chapter 7) is dropped; any other heading stays as a plain line.
 */
export function cleanChapterContent(content: string, chapterTitle = ''): string {
  const norm = (s: string) => s.replace(/^[第\d一二三四五六七八九十百]+[章节.、:：\s]*/, '').replace(/[\s:：、，,.\-—–]/g, '').toLowerCase();
  const titleKey = norm(stripMarkdownInline(chapterTitle));
  const lines = String(content ?? '').replace(/\r\n?/g, '\n').split('\n');
  const kept: string[] = [];
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    // Strip standalone divider lines (e.g. ==================== or --------------------)
    if (/^\s*[=_\-]{3,}\s*$/.test(trimmed)) continue;

    // Strip lines that are TOC chapter lists (e.g. "第3章：... 第4章：...")
    const chapterMatches = trimmed.match(/(?:第\s*\d+\s*章|Chapter\s+\d+)/gi);
    if (chapterMatches && chapterMatches.length >= 2) continue;

    const heading = raw.match(HEADING_LINE);
    if (heading) {
      const text = stripMarkdownInline(heading[1]).trim();
      const key = norm(text);
      if (!text || (titleKey && key === titleKey) || /^第[\d一二三四五六七八九十百]+章/.test(text) || /^chapter\s+\d+/i.test(text)) continue;
      kept.push(text);
      continue;
    }

    // Strip plain lines starting with Chapter / 第X章 when repeating chapter title or chapter index
    if (/^(?:第[\d一二三四五六七八九十百\d]+章|Chapter\s+\d+)[:：\s]/i.test(trimmed)) {
      const strippedText = trimmed.replace(/^(?:第[\d一二三四五六七八九十百\d]+章|Chapter\s+\d+)[:：\s]*/i, '').trim();
      const key = norm(strippedText);
      if (!strippedText || (titleKey && key === titleKey)) continue;
      kept.push(stripMarkdownInline(strippedText));
      continue;
    }

    kept.push(stripMarkdownInline(raw).replace(/\s+$/g, ''));
  }

  const firstIndex = kept.findIndex((line) => line.trim() !== '');
  if (firstIndex >= 0 && isTitleEcho(kept[firstIndex], chapterTitle)) kept.splice(firstIndex, 1);
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const pairsOf = (text: string): Set<string> => {
  const flat = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const out = new Set<string>();
  for (let i = 0; i < flat.length - 1; i += 1) out.add(flat.slice(i, i + 2));
  return out;
};

/**
 * True when `line` is just the chapter title again (same words, or a lightly reworded copy such as "马来西亚政治未来路径选择：…" for
 * "未来政治的路径选择：…"): short, not a full sentence, and sharing most of the title's character pairs.
 */
export function isTitleEcho(line: string, chapterTitle: string): boolean {
  const title = stripMarkdownInline(chapterTitle).replace(/^[第\d一二三四五六七八九十百]+[章节.、:：\s]*/, '').trim();
  const text = stripMarkdownInline(line).trim();
  if (!title || !text) return false;
  if (/[。！？!?]$/.test(text) || text.length > title.length * 1.6 + 8) return false;
  const a = pairsOf(title);
  const b = pairsOf(text);
  if (a.size === 0 || b.size === 0) return false;
  let hit = 0;
  for (const g of a) if (b.has(g)) hit += 1;
  return hit / a.size >= 0.7;
}
