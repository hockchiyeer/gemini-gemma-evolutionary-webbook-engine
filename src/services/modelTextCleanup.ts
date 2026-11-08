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
    const heading = raw.match(HEADING_LINE);
    if (heading) {
      const text = stripMarkdownInline(heading[1]).trim();
      const key = norm(text);
      // heading that repeats the title, or a numbered chapter heading ("第七章：...") that the book already prints itself
      if (!text || (titleKey && key === titleKey) || /^第[\d一二三四五六七八九十百]+章/.test(text) || /^chapter\s+\d+/i.test(text)) continue;
      kept.push(text);
      continue;
    }
    kept.push(stripMarkdownInline(raw).replace(/\s+$/g, ''));
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
