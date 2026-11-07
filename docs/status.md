# Status

Where the v0.1 prototype stands. Last updated 2026-11-06. The milestones come from the prototype brief, which lives with the product thinking in the founder's `NoemaLearningNote` workspace. Each session's details are in [`handoffs/`](handoffs/), the decisions in [`adr/`](adr/).

## Milestones

| Milestone | State | What it gives |
| --- | --- | --- |
| M0 Setup | Done | The repository, the fake model, the app shell, tests that run from a clean clone |
| M1 Chat that survives | Done | Answers stream and survive reloads and crashes, with tables, math and code; connect a model with your own key from the app |
| M2 Branch and return | Done | Ask a side question about any selected passage and go Back to that exact passage; make a side question its own thread, or merge what it found back in (nothing already said is rewritten); cut a thread that drifted into a new thread at a question, and join it back; titles the model writes and you can change |
| M3 Sources | Done | Add a web page (an arXiv paper is read from its HTML version) or pasted text; it opens in a reading pane with the conversation beside it; ask about any passage, and Back returns to it; passages asked about are marked, darker where you asked more; a page read again keeps what you asked with the version you asked it about |
| M4 Find again | Done | ⌘K search over everything, in English or Chinese, landing on the exact message, note block or passage; reopening where you were; side questions you never came back from; a map of each thread, each exchange labelled by what it established; catalogs for long threads and notes |
| M5 Context you can see | Under way | Done: **What was sent** under every answer, part by part and word for word; **About you**, sent with every question. To do: memory (statements about you that you write or accept, each linked to where it came from, and "asked before"), regenerate, Markdown and JSON export with import |
| M6 Dogfood | Next | Two weeks of real use with course material and the diary, then three classmates for a week |

Also built along the way: study notes made of blocks you edit in place, with AI suggestions you accept or discard, notes split and merged, and citations that open the exchange beside the note; notes listed under the thread or source they came from; a sidebar that shows one list at a time; the Trash, with Undo and Restore.

## How it is checked

- 185 unit and integration tests (`pnpm test`) and 49 end-to-end tests (`pnpm e2e`), all with the fake model.
- The brief's acceptance tests are in the suite (see [codebase.md](codebase.md#e2e-the-app-end-to-end)).
- Tried by the founder with DeepSeek on his Mac: connecting a key, streaming answers, prompt caching, titles and headlines, and reading a real arXiv paper (over 1,600 formulas, all rendered).

## Known gaps

- `pnpm lint` (Biome) and `pnpm e2e` have not been run on macOS lately; CI runs them on Linux for pull requests.
- CI installs without `--frozen-lockfile`; now that `pnpm-lock.yaml` is committed, it should.
- Images in web pages are not shown (their alt text is). PDFs cannot be read yet.
- Regenerate is not built: a bad answer cannot be asked again in place.
- No export button or import yet (`GET /api/export` returns everything as JSON).
- One notebook per install; no accounts, sync or mobile layout (out of scope for v0.1).

## Next

1. Memory, as proposed in the latest handoff, once agreed.
2. Regenerate, then export and import (the rest of M5).
3. M6: real use, with a short list of what gets in the way.
