# Handoff 2026-11-06: merge cards at the passage, a catalog, and a way out of deep detours

The founder noticed merged cards sat at the bottom of the answer, asked for a catalog (a sidebar of dots) to move around long threads and notes, and asked how to avoid "recursion hell" across branches, splits and merges.

## What changed

- **A merged side question's card sits at its passage**: inside the answer, right after the paragraph, list or table that holds the passage (`Markdown` slots). Content shown inside an answer is marked foreign, so selecting in it is never taken for a passage of the answer and highlights ignore it. Merges from other threads (no passage) still sit after the target's last message.
- **A catalog on the right** (`Outline.tsx`) of threads with three questions or more, and of notes with two headings or more. A short mark per question (or heading, indented by level); side questions (↳) and merges (⤶) under the question they started from. It opens into labels on hover or keyboard focus, marks where you are while scrolling, and jumps on click (a side question jumps to its passage). Hidden below 900 px wide.
- **Recursion guards**:
  - What already held: threads form a tree (a side question's parent is fixed when it is asked); a merge is a snapshot of text, and the AI's draft reads only the source's own exchanges, never what was merged into it, so merges never nest; no merging into a thread's own side questions; hard limits (20 levels for maps and outlines, passage and merged-text length, the context budget dropping the oldest turns first).
  - New: **merging the same thread into the same target again replaces the earlier merge** (the draft says so), so a thread never carries two versions.
  - New: **⇤ Back to the main thread** on side questions two or more levels deep: straight to the top thread, at the passage where the chain of detours began, highlighted. Back still goes up one level.
- Test helper: `doubleClickWord` scrolls the word into view first (it could select nothing on long pages).

## Verified

| Check | Result |
| --- | --- |
| `tsc` on core, server, web and the root project (founder's Mac) | Clean |
| `node --test` (Mac and sandbox) | 136 pass. New: merging the same side question again replaces the earlier merge, only the newer one is carried; merges carry the passage's anchor |
| Playwright (sandbox, Chromium) | 28 pass. New: the merge card sits inside the answer right after the passage's paragraph, and double-clicking inside it offers no branch; a long thread's catalog (three questions, a side question, jump to the third question and back to the first, "you are here"); a note's catalog of headings; Back to the main thread from two side questions deep |
| Screenshots | Card inside the answer; catalog closed and open |

Not verified: Biome (`pnpm lint`), Playwright on the Mac.

## Later the same day: merged cards open and close

- A merged card starts closed: one line saying where it came from, then the start of its text. Click the line (or the ▸) to open it; click ▸ again to close it. Each reader's choice is kept per card in the browser (`noema:merge-open:<id>`), so a card left open stays open. Choosing a merge in the catalog opens it.
- Verified: Playwright 28 pass (the merge test now checks closed by default, opening, staying open after leaving and coming back, closing, staying closed after a reload, opening from the preview line); `tsc` on the Mac clean. The catalog opening a card was checked by script and screenshot, not by a test.

## Next

- "Side questions you never came back from" when opening Noema (insight I3).
- Search with jump-to-message; M3 sources.
