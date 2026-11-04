# 0004. An offset-preserving Markdown renderer

Date: 2026-11-04. Status: accepted.

## Context

Branches and pins start from a selection in a rendered answer, and anchors are offsets into the raw Markdown. So the renderer must know, for every rendered character, where it came from. The reliability handoff suggested Streamdown for streaming Markdown. Streamdown and react-markdown render well, but neither gives a character-level map from DOM text back to source offsets out of the box.

## Decision

- Parse with `mdast-util-from-markdown` plus `micromark-extension-math` and `mdast-util-math` (the same unified/micromark stack react-markdown is built on). Every mdast node carries source offsets.
- Render mdast to React ourselves (`apps/web/src/markdown/Markdown.tsx`). Each text leaf is a `<span data-s data-e>` with its raw range. Inline and fenced code map inside their delimiters. Rendered math is atomic: a selection touching it covers the whole formula, `$` signs included.
- `parse.ts` aligns each leaf's rendered text with its raw slice (Markdown only deletes characters: escapes, indentation, quote markers), so selections across a line break inside a list or quote keep the raw characters between.
- `selection.ts` maps a DOM selection to raw offsets and back, for highlighting with the CSS Custom Highlight API.
- Raw HTML in Markdown is shown as text. Links are limited to http(s) and mailto. Images are not loaded.

## Consequences

- Partial Markdown while streaming is handled by micromark itself: an unclosed fence or `$$` simply runs to the end.
- Unit tests cover the mapping (`apps/web/test/parse.test.ts`); Playwright covers real selections, including a double-click, a selection inside KaTeX, and one across a list, inline code and Chinese text.
- Not yet: GFM tables and strikethrough, and code highlighting. Each needs its leaves mapped the same way.

## How to reverse

Rendering could move to react-markdown with custom components that emit the same `data-s`/`data-e` spans; `parse.ts` and `selection.ts` would stay.
