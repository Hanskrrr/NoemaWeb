# Handoff 2026-11-06: new thread from here

The founder asked to split a thread halfway: make a whole other thread from a certain question. His main thread had drifted from one subject into another, and its note mixes both. Decisions are in [ADR 0010](../adr/0010-new-thread-from-here.md).

## What changed

- **New thread from here.** Hovering any question after the first shows "↪ New thread from here". A short confirmation says what will move ("This question and the 2 after it, with 1 side question") and that the new thread won't send the earlier conversation to the model. Confirming moves that question and everything after it into a new top-level thread and opens it. The model titles it from its first exchange.
- **What moves with it.** The same messages (nothing copied or rewritten): their side questions, merges accepted after the cut (the cards and what they carry), threads split off earlier from that part, citations in notes and merges (they open the exchange in its new thread), and search hits.
- **Each links to the other.** The new thread starts with "Split off from <original> · ⤺ Join back"; the original ends with "This thread continues in <new> →". The maps say the same.
- **Join back** puts every question back where it was and removes the new thread, then shows the first question that had moved. It is offered only while the original has no new questions since the cut and neither thread has a merge with the other; otherwise the card says why.
- **Server.** `POST /api/threads/:id/split-off` `{id, messageId}` (idempotent on `id`), `POST /api/threads/:id/join-back`; `Thread.continuedFromId`; the thread detail and the map carry `continuedFrom` and `continuedIn`. Migration 009 adds `thread.continued_from` and `continued_at_seq`.

## Verified

| Check | Result |
| --- | --- |
| `node --test` (sandbox and founder's Mac) | 157 pass. New: splitting a thread with a side question, an accepted merge and a note moves exactly the questions from the cut on (same ids and revisions, renumbered), the side question with its passage, the merge and its place, the note's citations to the moved exchanges, and the search hits; each side links to the other on the page and the map; the next question in each sends only its own exchanges; the same request twice is answered once; join back restores the original order, side question, merge and citations exactly and removes the new thread; join back refused (409) after a new question in the original and (400) for a thread never split off; refused at the first question, at an answer, at another thread's question and while an answer is being written; a side question can be split too |
| Playwright (sandbox, Chromium) | 33 pass. New: split at the second of three questions with a side question on the third; the new thread holds the two questions and the side question, says where it came from, and its map too; the original ends with the link on; join back returns all three and shows the first one that had moved. The new and the find-again specs now wait for each question's own answer (the old wait could pass on the previous answer and drop a question; it made the new spec fail once) |
| `tsc` on core, server, web and the root project (founder's Mac) | Clean |
| Screens | The action on hover, the confirmation, the new thread's card, the original's last line (light, desktop) |
| Founder's notebook | His `pnpm dev` upgraded `data/noema.db` to schema 9; threads, messages and blocks unchanged (7, 26, 170). Nothing was split. Copy before: `data/backups/noema-before-split-off-2026-11-06.db` |

## Not verified

- `pnpm lint` (Biome) still could not run here (no packages in the sandbox, no registry access); please run it with `pnpm e2e` on the Mac.
- The older specs (merge, notebook) still use the old wait; they pass, but may flake the same way.

## Next

- Try it on the thread that drifted: "New thread from here" on the first question of the second subject moves those questions and the side questions asked from their answers; then "Rewrite as note" in each thread gives two separate notes.
- M3 sources, then M5.
