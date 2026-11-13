# Ideas parking lot

Things worth doing that are outside the v0.1 scope fence or not yet scheduled. Add here instead of to the code.

## After v0.1

- **Import a ChatGPT export**: second candidate.
- **PDFs, next steps** (text, pages and page pictures are built, ADRs 0021 and 0022): draw a box around a figure or formula and ask about just that (a crop sent as the picture); formulas as LaTeX (from the PDF's own text where a TeX source made it, or the model reading the page picture); a paragraph across a page break joined; OCR for scanned pages; the PDF's own outline as headings.
- **Sources, next steps** (ADR 0013): figures, kept as local copies from the original HTML; for a passage asked about an older version, propose where it is in the latest one (shown as a proposal, never a silent jump); a question about a whole section from its heading; the passages asked most across all sources, in one list.
- Semantic search with sqlite-vec, only if keyword search misses in real use.
- An MCP server over the notebook, so other tools can read it.
- A desktop shell (Tauri or Electron) around the same server and web app.
- **"Asked before", next steps** (built, ADR 0020): give the model the earlier exchange, labelled *asked before*, so it explains differently instead of repeating; suggest merging two threads that asked the same thing; embeddings only if matching by words misses in real use.
- **Bookmarks** (brief M4): mark a passage to find again without asking about it. Search and the map may make them unnecessary; wait for real use.
- **Search filters**: only notes, only this thread, by date. Add when a real search returns too much.
- **Folders, next** (folders are built, ADR 0025): files read again when they change on disk (a watcher) rather than when opened; files in ⌘K search before they are opened; colours for code in the reader and the editor; pictures in a folder shown, and sent with a question; several files made into notes at once; `[[links]]` between Markdown files followed (closer to an Obsidian import, which is outside the fence); a note kept in step with its file.
- **The Assistant, next steps** (step 1 is built, ADR 0023, with changes it proposes and the learner confirms, ADR 0024; each further step is the founder's decision): (2) memory items it proposes and you keep, each linked to the exchange it came from, sent with every question; (3) background jobs with a budget ("go through all six decks…", "draft a Week 4 note"), run as workers, whose results come back as suggestions you accept or discard (a note, a merge, a link between threads, a pin, the Trash), through the same routes as the buttons so Undo works; (4) noticing things on its own from events Noema already logs (a new source, a side question not come back from, an asked-before match), filtered by code first, Off / Observe / Suggest per kind, never changing the notebook by itself. Also: the Assistant looking at a PDF page picture; an "Ask the Assistant" button on a selection; several changes confirmed at once. The idea follows DeepSeek's Super-agent prototype (one router that speaks for the system, workers for slow jobs, tickets in SQLite, observe mode first).
- **Ask in several branches at once**: select a passage and send two or three side questions that run in parallel, each its own branch (Super Agent runs workers in parallel and keeps their state in a database, which is how answers already work here).
- **One study structure** (drafted and checked, [handoff 2026-11-12](docs/handoffs/2026-11-12-study-structure-check.md)): texts, passages, links and collections behind side questions, pins, citations, "asked before" and margin marks, exported in the W3C annotation form. Steps: export it from the tables as they are; remember asked-before answers as links; margin marks ("met before") on a new source. Links between passages are close to the scope fence: the founder decides.
- **A note from passages**: write a short note on a selected passage, anchored like a branch, shown in the margin and on the map.
- **Note history view**: every version of a note is kept (`note_revision`, with what changed and the blocks); show them and restore one.
- **Notes, next steps**: merge two blocks, drag to reorder, keyboard moves between blocks (Jupyter's Esc/Enter modes), and moving out a middle range of a thread (from here to the end is done: "New thread from here").

## Engineering, not yet scheduled

- Show the model's reasoning while it thinks. DeepSeek's models think by default and stream it as `reasoning_content`, which Noema ignores for now, so the learner sees "Thinking…" until the answer starts.

- Lazy-load KaTeX and its fonts; the web bundle is about 600 KB minified, mostly React and KaTeX.
- Property tests for anchors with fast-check, once the dependency is installed.
- Swap `node:sqlite` for better-sqlite3 if Node's module changes its API before it is stable (ADR 0002).
- **Empty the Trash / delete for good** (ADR 0012): remove a thread for real. Before that: detach side questions that became their own threads (their `parent_thread_id` cascades), keep merges it gave other threads (make the source nullable, keep its title), and show a citation to a removed exchange as removed.
