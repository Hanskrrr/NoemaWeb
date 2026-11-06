# Ideas parking lot

Things worth doing that are outside the v0.1 scope fence or not yet scheduled. Add here instead of to the code.

## After v0.1

- **Import a ChatGPT export**: second candidate.
- PDF sources via the pdf.js text layer.
- Semantic search with sqlite-vec, only if keyword search misses in real use.
- An MCP server over the notebook, so other tools can read it.
- A desktop shell (Tauri or Electron) around the same server and web app.
- **"You've asked this before"** (from DeepSeek Super Agent's router, which keeps context across sessions): when a new question is close to an earlier exchange anywhere in the notebook, show that exchange next to the answer. Starts with keyword search; no embeddings until search misses in real use.
- **Ask in several branches at once**: select a passage and send two or three side questions that run in parallel, each its own branch (Super Agent runs workers in parallel and keeps their state in a database, which is how answers already work here).
- **A note from passages**: write a short note on a selected passage, anchored like a branch, shown in the margin and on the map.
- **Note history view**: every version of a note is kept (`note_revision`); show them and restore one.

## Engineering, not yet scheduled

- Show the model's reasoning while it thinks. DeepSeek's models think by default and stream it as `reasoning_content`, which Noema ignores for now, so the learner sees "Thinking…" until the answer starts.

- Lazy-load KaTeX and its fonts; the web bundle is about 600 KB minified, mostly React and KaTeX.
- Property tests for anchors with fast-check, once the dependency is installed.
- Swap `node:sqlite` for better-sqlite3 if Node's module changes its API before it is stable (ADR 0002).
