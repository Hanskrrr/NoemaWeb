# Handoff 2026-11-23: concepts cards that read as one list

Branch `concepts/less-noise`, on top of `notebook-features` (`3a9fb3c`). Not pushed.

## Why

The founder found the room's concept display confusing (ADRs 0035, and 0038's
addendum: a zoomable map was tried and removed the same day). The cards by topic
(ADR 0038 addendum) were still laid out in three fixed lanes, with every depth
past two folded into "Goes further", and every topic open at once. The work here
is presentation only: no model, contract, migration or ADR changes.

## What changed

- **One column, not three lanes.** `RoomConcepts.tsx` no longer uses the fixed
  `LANES` list or `Math.min(2, level)`. `pathOrder` still gives the order; all
  visible cards of a topic render in one column (`sec.column`). Nothing is
  folded by depth.
- **Relations in words.** A card shows up to two links as text (`builds on X`,
  `contrasts with X`), `data-testid="concept-rel"`, alongside the existing
  `concept-under` ("a kind of X"). The "inside: …" line was taken off the card:
  the drawer already has a fuller Inside list with keep/dismiss buttons.
- **Later topics start folded.** `closed` starts as null, meaning "only the
  first topic is open"; the first toggle turns that into an explicit set, so
  the learner's choices stick. Find still opens everything it matches.
- **Dragging text on a card.** `onDragStart` used to refuse any event whose
  target was not the card element. It now refuses only buttons, inputs,
  selects, textareas and links, so dragging from the new relation text works.
- **The lines are gone.** Relations were already written on the cards; the SVG
  line layer and its box-measuring code were left behind and are removed. No
  floating labels between cards in a single column.
- **Three lenses** (display only, no new data, no model call): Study order (the
  default: later topics folded, relations on cards), Explore (all topics open),
  Audit gaps (all topics open, no relations on cards, one line counting ideas to
  review, materials under no concept and open questions). The choice is kept in
  `localStorage` (`noema:concepts-lens`) and never sent to the server.

## Verified, and how

- New e2e first, red then green: `room-views.spec.ts` "Concepts: cards sit in
  one column with relations in words, and later topics start folded". It makes
  a second topic by hand, reopens the room, and checks the second topic's
  `aria-expanded="false"`, one `concepts-lane`, and a visible `concept-rel`.
- `pnpm exec playwright test -c e2e/playwright.config.ts room-views.spec.ts`:
  **10/10 pass** after the lenses were added. Two older assertions were updated for the new default: the
  "In no topic" section is opened before asserting what is in it, and the
  drawer is closed before a card drag (in one column it covers the cards).
- `pnpm typecheck`: clean.
- `pnpm test` on **this branch and on the parent branch in a separate worktree**:
  the same **27 named failures** in both, byte-for-byte after removing timings.
  They are environment failures (PDF worker, `E:\E:\` path joining, POSIX 0600
  on Windows), not caused by this change. No new failure.
- `pnpm exec playwright install chromium` was needed and done (Playwright 1.64.1,
  Chromium headless shell 156).

## Not verified

- `pnpm lint` (Biome): not run on Windows in this session.
- DeepSeek: never used in tests. How the new card copy reads on a real notebook
  with many concepts is for the founder to judge on the Mac.
- The full e2e suite was not run in this session; only `room-views.spec.ts`.
- Visual check: screenshots of Study and Audit with a fake room (light theme),
  inspected in the browser; the lens selector and the gap line are readable.
- Known, not fixed here: a card's drawer covers cards in one column; and a
  fake-model pair of opposite links can put "builds on X" on both cards. An
  attempt to deduplicate the pairs in the view made a drag test fail reliably
  (card height changed the drop point), so it was reverted. Both belong to a
  later change.

## Notes for the PR

- `pnpm-lock.yaml` does not include the `pdfjs-dist@6.2.108` that
  `apps/server/package.json` declares. CI uses plain `pnpm install`, so this PR
  is not blocked; left untouched here. The founder should commit the lockfile
  update and switch CI to `--frozen-lockfile` separately (also in status.md's
  known gaps).
- `docs/status.md`: only the line about the Concepts display is touched.
