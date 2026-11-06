# Handoff 2026-11-06: a line per exchange on the map and in the catalog

The founder found the map hard to read: each exchange was labelled with the question as asked ("what is this"), which says nothing on its own. He asked for a short summary of each round of Q&A instead.

## What changed

- **A headline per exchange.** After each answer finishes, the model writes one short line saying what the exchange established, the point of the answer rather than the question (at most 12 words, or 24 characters in Chinese or Japanese; same language as the question). A side question's line is written knowing its passage. It is a light call (thinking off on DeepSeek), run together with the thread title, before the answer's stream ends, so the page that refreshes on "end" already has it. The answer text is never changed; the line is stored beside it (`message_revision.headline`, migration 007). A failed line leaves none; the answer is unaffected.
- **Earlier answers** get their lines at start-up, one call at a time, after any missing thread titles.
- **The map** leads each exchange with its line (opens the answer), with "You asked: …" beneath (opens the question). Without a line yet, it shows the question and the start of the answer as before.
- **The catalog** labels each question with its line; hovering shows the question as asked.

## Verified

| Check | Result |
| --- | --- |
| `node --test` (sandbox) | 141 pass. New: a line is written before the answer's end and appears in the thread and the map; none for failed answers, and a failed line leaves the answer done; earlier answers get lines at start-up; a side question's line request carries its passage; replies are cleaned to one line |
| Playwright (sandbox, Chromium) | 28 pass. The map test checks the line, "You asked", and that the line opens the answer; the catalog test checks the label and its hover text |
| `tsc` on core, server, web and the root project; `node --test` (founder's Mac) | Clean; 141 pass |
| Founder's notebook, real DeepSeek | His `pnpm dev` restarted, upgraded `data/noema.db` to schema 7 and wrote lines for all 13 earlier answers. Exchanges asked as a bare "what is this" now read as what their answers established. A copy before the upgrade: `data/backups/noema-before-headlines-2026-11-06.db` |

## Next

- Watch new lines for a while; tune the prompt if they read like questions or run long.
- Let the learner edit a line on the map (and keep it, like a renamed title).
