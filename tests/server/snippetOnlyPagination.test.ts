import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { isSnippetOnlySourceMode } from '../../src/types.ts';
import { buildChapterRenderPlan } from '../../src/utils/webBookRender.ts';
import { WebBookViewer } from '../../src/WebBookViewer.tsx';
import type { Chapter, WebBook } from '../../src/types.ts';

// 1. isSnippetOnlySourceMode recognises both fallback_search and search-fallback
{
  assert.equal(isSnippetOnlySourceMode('fallback_search'), true);
  assert.equal(isSnippetOnlySourceMode('search-fallback'), true);
  assert.equal(isSnippetOnlySourceMode('gemini'), false);
  assert.equal(isSnippetOnlySourceMode('hybrid'), false);
  assert.equal(isSnippetOnlySourceMode('model_knowledge'), false);
  assert.equal(isSnippetOnlySourceMode(undefined), false);
  assert.equal(isSnippetOnlySourceMode(null), false);
}

// 2. A realistic scraped search-fallback snippet produces exactly 1 narrative page (not padded to 3)
{
  const snippetContent = [
    'Cloud infrastructure demand reached record highs this quarter driven by foundational AI models and high-density computing clusters.',
    'Hyperscale providers reported significant capital expenditure increases focused on GPU procurement, power delivery, and liquid cooling architectures.',
    'Analysts note that power availability and grid interconnection timelines remain the primary bottlenecks for new facility deployments.',
  ].join(' ');

  const chapter: Chapter = {
    title: 'Hyperscale Infrastructure Dynamics',
    content: snippetContent,
    definitions: [],
    subTopics: [],
    sourceUrls: [{ title: 'Cloud Report', url: 'https://example.com/cloud' }],
    visualSeed: 'Hyperscale Infrastructure Dynamics',
  };

  // Test both 'fallback_search' and 'search-fallback'
  for (const sourceMode of ['fallback_search', 'search-fallback'] as const) {
    const plan = buildChapterRenderPlan([chapter], { sourceMode });
    assert.equal(plan.length, 1);
    const textPages = plan[0].textPages;

    assert.equal(
      textPages.length,
      1,
      `Snippet-only chapter in mode "${sourceMode}" must produce 1 page, not pad to 3 pages`
    );
    assert.equal(textPages[0].pageKind, 'opening');
    assert.ok(textPages[0].content.includes('Cloud infrastructure demand'));
  }
}

// 3. Multi-page snippet-only scaling: 2 pages for ~500 words, without padding or duplicate paragraphs
{
  const paragraphA = 'Paragraph Alpha: ' + Array.from({ length: 260 }, (_, i) => `wordA${i}`).join(' ');
  const paragraphB = 'Paragraph Beta: ' + Array.from({ length: 260 }, (_, i) => `wordB${i}`).join(' ');
  const twoPageContent = `${paragraphA}\n\n${paragraphB}`;

  const chapter: Chapter = {
    title: 'Medium Snippet Chapter',
    content: twoPageContent,
    definitions: [],
    subTopics: [],
    sourceUrls: [],
    visualSeed: 'Medium Snippet Chapter',
  };

  const plan = buildChapterRenderPlan([chapter], { sourceMode: 'fallback_search' });
  assert.equal(plan.length, 1);
  const textPages = plan[0].textPages;

  assert.equal(textPages.length, 2, 'Two-paragraph ~500 word text should scale to 2 pages');
  assert.notEqual(textPages[0].content, textPages[1].content, 'Pages must not repeat the same paragraph');
  assert.ok(!textPages[1].content.includes('Paragraph Alpha'), 'Page 2 should not copy Page 1 content');
}

// 4. Gemini mode with standard rich content retains 3 narrative pages
{
  const p1 = 'Introduction to modern semiconductor architecture. '.repeat(10);
  const p2 = 'Detailed exploration of high-bandwidth memory constraints. '.repeat(10);
  const p3 = 'Future trajectory of advanced packaging and optical interconnects. '.repeat(10);
  const richContent = `${p1}\n\n${p2}\n\n${p3}`;

  const chapter: Chapter = {
    title: 'Semiconductor Fab Constraints',
    content: richContent,
    definitions: [],
    subTopics: [],
    sourceUrls: [],
    visualSeed: 'Semiconductor Fab Constraints',
  };

  const plan = buildChapterRenderPlan([chapter], { sourceMode: 'gemini' });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].textPages.length, 3, 'Gemini synthesized chapters should retain 3 narrative pages');
  assert.equal(plan[0].textPages[0].pageKind, 'opening');
  assert.equal(plan[0].textPages[1].pageKind, 'analysis');
  assert.equal(plan[0].textPages[2].pageKind, 'synthesis');
}

// 5. Empty content drops pages instead of creating duplicate filler
{
  const emptyChapter: Chapter = {
    title: 'Empty Chapter',
    content: '',
    definitions: [],
    subTopics: [],
    sourceUrls: [],
    visualSeed: 'Empty Chapter',
  };

  const plan = buildChapterRenderPlan([emptyChapter], { sourceMode: 'fallback_search' });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].textPages.length, 0, 'Empty chapter should drop narrative pages entirely');
}

// 6. Chapter images are rendered in snippet-only / fallback mode for HTML & High Res export
{
  const fallbackBook: WebBook = {
    id: 'b-fallback',
    topic: 'Offline Semiconductor Analysis',
    timestamp: 1_700_000_000_000,
    sourceMode: 'fallback_search',
    chapters: [{
      title: 'Chapter 1: Foundational Architecture',
      content: 'Short evidence text describing semiconductor design patterns.',
      definitions: [],
      subTopics: [],
      sourceUrls: [],
      visualSeed: 'silicon wafer layout',
    }],
  };

  const markup = renderToStaticMarkup(React.createElement(WebBookViewer, { webBook: fallbackBook }));
  assert.ok(markup.includes('<img '), 'WebBookViewer must render img element for chapter image in fallback mode');
  assert.ok(markup.includes('picsum.photos/seed/silicon'), 'Image must use visualSeed or chapter title');
  assert.ok(markup.includes('silicon wafer layout'), 'Visual seed badge must be rendered');
}

console.log('snippetOnlyPagination tests passed');
