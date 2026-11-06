# Handoff 2026-11-06: find again (M4)

The brief's M4: search with jump-to-message, and the insight "side questions you didn't come back from". Acceptance tests 1 (zero records) and 5 (find again inside a branch) now pass. Decisions are in [ADR 0009](../adr/0009-find-again.md).

## What changed

- **Search everything, from anywhere.** ⌘K (Ctrl+K, or "/" when not typing) or the Search box in the header. It searches questions, answers (with their headlines), thread titles, note titles and note blocks, in English, Chinese and Japanese (one-character Chinese words too). Each hit shows where it is (the main thread › the side question), whether it is your question, an answer, a title or a note block, the date, and a snippet with the words marked. The side question's own name stays readable when the line is short of room.
- **A hit opens the exact place.** Enter or a click opens the exact message (inside side questions too) or note block, marks the words searched for there and centres the first, so a long answer opens at the matching line. Notes open at a block with a new route, `#/note/<id>/b/<block>`. Enter while a Chinese or Japanese input method is composing picks the word, not a hit.
- **Side questions you never came back from.** Search with nothing typed lists them, newest first, with the passage and thread each came from, and "Not now" to take one off the list. A side question counts as left open after an answer when nothing took you back: no Back to the passage, no later question in the thread above, not merged back or made its own thread, not set aside. Asking in it again opens it again.
- **Noema reopens where you were.** Opened with nothing in the URL, it returns to the last thread, side question, map or note open in this browser, unless a thread has had something newer since. When opened fresh it also names the side questions left open in one line under the header (not the one you are in), hidden with × or by going anywhere.
- **Server.** The index covers notes (kept in step on every note change) and headlines; migration 008 adds a `meta` table holding the index version, and start-up rebuilds the index when the code's version is newer. New routes: `GET /api/notebooks/:id/open-branches`, `POST /api/threads/:id/set-aside`, `POST /api/search/opened` (logs the hit's kind, rank and the query's length, never its words). `GET /api/search` now also returns the query's terms. Version `0.1.0-m4.0`.

## Verified

| Check | Result |
| --- | --- |
| `node --test` (sandbox and founder's Mac) | 153 pass. New: a word in a side question's question finds it, with the path above it; a headline-only word finds the answer, snippet from the line; notes found as they are now through edit, delete, restore, move out, merge, rename and delete; citation labels are not words; a title is its own hit only when nothing inside matched; the index rebuilds once for an older notebook; search.opened logs no words; the left-open rules (Back, asking again, Not now, a later question above, merge, split); snippet marks, where/what/when labels and the block route |
| Playwright (sandbox, Chromium) | 32 pass, 4 new: acceptance 1 (ask, branch, Back, quit, reopen in the main thread, search, open the side question's message, ask again there); acceptance 5 (a word three questions into a side question, chosen with the arrow keys, opens that message in view with the word marked; Chinese search; "Nothing found"); a note block hit; the left-open list, "Not now", and the reopened line |
| `tsc` on core, server, web and the root project (founder's Mac) | Clean, after one fix it caught (commit `c43e2c1`) |
| Screens | Light and dark, desktop and phone width (390 px): the header box, the dialog empty and with hits, an arrived message with the word marked, the left-open line |
| Founder's notebook | His `pnpm dev` restarted, upgraded `data/noema.db` to schema 8 and rebuilt the index: 7 thread titles, 26 messages, 3 note titles, 145 blocks. On a copy, a few words he had used each found the expected answers, with their paths; no side questions are left open. Copy before the upgrade: `data/backups/noema-before-search-2026-11-06.db` |

## Not verified

- **`pnpm lint` (Biome) did not run.** The sandbox lost its installed packages and the npm registry was unreachable from it this session; the Biome binary could not be fetched either. The code follows the repository's Biome rules as far as I can tell; please run `pnpm lint` (and `pnpm e2e`, for a second run on macOS).
- The sandbox e2e ran against a web build made with esbuild, not `vite build`, for the same reason.
- Only the fake model in tests; real DeepSeek was not called this session.

## Watch in real use

- On the founder's notebook, long note blocks rank above the exchanges they came from (they repeat the words). If a search should land on the exchange first, weigh messages above blocks before cutting the list.
- Each note change reindexes the whole note. Fine at 170 blocks; watch typing in a very long note.

## Next

- M3 sources (paste or fetch a page, read it beside the thread, ask about a passage of it), the hero case of the brief.
- Then M5: the context panel, About me, pins, Markdown and JSON export, import.
- "You've asked this before" (insight I2) can now reuse search: see `ideas.md`.
