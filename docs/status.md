# Status

Where the v0.1 prototype stands, milestone by milestone. The milestones come from the prototype brief, which lives with the product thinking (PARADIGM, interviews) in the `NoemaLearningNote` workspace, not here. Each session's details are in [`docs/handoffs/`](handoffs/), and the decisions in [`docs/adr/`](adr/).

| Milestone | State | What it gives |
| --- | --- | --- |
| M0 Setup | Done | The repository, the fake model, an app shell, tests from a clean clone |
| M1 Chat that survives | Done | Answers stream and survive reloads and crashes, with tables, math and code; connect a model with your own key |
| M2 Branch and return | Done | Ask a side question about any selected passage; go Back to that exact passage; make a side question its own thread, or merge what it found back in (nothing already said is rewritten); cut a thread that drifted into a new thread at a question, and join it back; titles the model writes and you can change |
| M3 Sources | Done | Add a web page (an arXiv paper is read from its HTML version) or pasted text; it opens in a reading pane with the conversation beside it; ask about any passage, and Back returns to it; passages you asked about are marked, darker where you asked more; a page read again keeps what you asked with the version you asked it about |
| M4 Find again | Done | Search everything with ⌘K, in English or Chinese, and land on the exact message, note block or passage; reopen where you were; side questions you never came back from; a map of each thread, each exchange labelled by what it established; catalogs for long threads and notes |
| M5 Context you can see | Under way | Done: What was sent under any answer, part by part, word for word; About you, sent with every question. Next: memory (statements about you that you write or accept, each linked to where it came from, and "asked before"), regenerate, Markdown and JSON export with import |
| M6 Dogfood | Next | Two weeks of real use with course material, then three classmates |

Also built along the way: study notes made of blocks you edit in place, with AI suggestions you accept or discard, split and merged notes, and citations that open beside the note; notes listed under the thread or source they came from; a sidebar that shows one list at a time; the Trash, with Undo and Restore.

Not yet checked on the founder's Mac: `pnpm lint` (Biome) and `pnpm e2e`.
