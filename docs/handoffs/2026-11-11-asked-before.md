# Handoff 2026-11-11: asked before

The founder's idea: do not add threads or notes that are not needed; if something was asked before, say where. He agreed to build it, starting with the matcher run over his own questions. Decisions are in [ADR 0020](../adr/0020-asked-before.md).

## What changed

- **The matcher** (`packages/core/src/asked.ts`): whether a question being written repeats an earlier exchange, by its subject words. Question words and politeness are dropped in English and Chinese; Chinese is compared as pairs of characters; rare words count more; a question on a passage is its passage; an earlier exchange also counts its thread's title and its headline. `same` or `related`; at most two, one per thread; never the thread being asked in, the threads it came from, or the Trash.
- **The reminder** (`apps/web/src/AskedBefore.tsx`, in `DraftView`): above the box in a new thread, a side question or a question about a source: **You asked this before** (or *about this*), the earlier question with its thread, date and headline, **Open it** (the draft is kept), **Ask there** (the question goes into the earlier thread; no thread is made), and × to dismiss. Asking anyway is just asking. A side question on a passage already asked about shows the earlier one before anything is typed.
- **Notes.** **Turn into a note** on a thread that already has a note says so, with *write another*.
- **Server.** `POST /api/notebooks/:id/asked`, `POST /api/asked/events` (what was done with a reminder: shown, opened, asked there, asked anyway, dismissed; with the strength and the place, never the words). `repo.askedCandidates`, `repo.lineage`. No migration.
- The push log records the push of 2026-11-07 (`5bb1ccb`, by the founder).

## Verified

| Check | Result |
| --- | --- |
| `node --test` (sandbox and the founder's Mac) | 214 pass. New: subject words in English and Chinese; the same question in other words found; a question on a passage found by its passage, typed out too; different questions that share a word left alone; one per thread, never the lineage; over HTTP: found with where and when, nothing for a different or empty question, the Trash, the log without words |
| Playwright (sandbox, Chromium) | 59 pass, twice in a row. New, `e2e/asked.spec.ts`: in a new thread a different question brings nothing and a repeat brings the reminder; Open it shows the earlier exchange and keeps the draft; Ask there sends the question into the earlier thread without adding a thread; dismissing and asking makes a new thread; a side question on a passage already asked about shows the earlier one first; a second note from the same thread asks first |
| `tsc` on core, server, web and root (the founder's Mac) | Clean |
| The founder's notebook, replayed in order on a copy | Each of his 23 questions checked against those before it, as the app would: **1 reminder, and it is a real repeat** (a new thread asking what an earlier thread began with); no wrong reminder. I saw no repeat that it missed, but 23 questions is a small sample |

## Not verified

- `pnpm lint` (Biome) and `pnpm e2e` on the Mac.
- The thresholds on a larger notebook. The log (`asked_before.*`) will show how often reminders are followed or dismissed.

## Next

- Use it; tune the thresholds if reminders are dismissed often or repeats slip through.
- Possible next steps are in `ideas.md`: give the model the earlier exchange so it explains differently; suggest merging threads that asked the same thing.
- Still to discuss: memory beyond About you, and the "new to you" idea.
