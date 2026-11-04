# Ideas parking lot

Things worth doing that are outside the v0.1 scope fence or not yet scheduled. Add here instead of to the code.

## After v0.1

- **Make a page from this thread**: a readable page on request, linking back to the chat. First candidate after v0.1 (the founder's diary asks for it).
- **Import a ChatGPT export**: second candidate.
- PDF sources via the pdf.js text layer.
- Semantic search with sqlite-vec, only if keyword search misses in real use.
- An MCP server over the notebook, so other tools can read it.
- A desktop shell (Tauri or Electron) around the same server and web app.

## Engineering, not yet scheduled

- Lazy-load KaTeX and its fonts; the web bundle is about 600 KB minified, mostly React and KaTeX.
- GFM tables and strikethrough in the renderer (`micromark-extension-gfm` plus `mdast-util-gfm`), keeping offsets.
- Property tests for anchors with fast-check, once the dependency is installed.
- Swap `node:sqlite` for better-sqlite3 if Node's module changes its API before it is stable (ADR 0002).
