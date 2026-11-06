# Handoff 2026-11-06: a block per paragraph, a catalog for every note, families in the sidebar

The founder reported three things; all three reproduced. Decisions are in [ADR 0011](../adr/0011-one-element-per-block.md).

| He saw | Cause |
| --- | --- |
| A note he built himself has no catalog | The catalog listed only headings, and only from two of them. Text written in one box stayed one block, so a heading typed above a paragraph was not a heading block |
| The AI writes only one block | By design: its prompt said "write exactly one block", and an accepted suggestion stayed one block however much it held. One of his notes was 2 blocks holding 6 elements |
| The sidebar gets messy after split, merge and "make it its own thread" | A side question made its own thread, and a thread split off at a question, were listed as separate top-level threads ordered by their own last activity, so they drifted away from where they came from, with unrelated threads in between. A merged side question lost its ↳ mark |

## What changed

- **A block per element.** Saving a block, writing a new one or accepting an AI suggestion splits the text into one block per paragraph, heading, list, table, code block or display formula (`splitBlocks`); the first keeps the block's id. Code fences and `$$` math with blank lines inside stay whole. Blocks from before that held several were split at start-up, once.
- **The AI writes as much as asked.** The suggestion prompt now allows a short section (heading, paragraphs, lists, formulas) for new text, and a rewrite may become two blocks. It is still one suggestion to accept or discard; accepted, it becomes several blocks. The fake model writes a section for `[[section]]`.
- **A catalog for every note.** Headings when the note has two or more; otherwise, from four blocks on, every block by its first sentence.
- **Families in the sidebar.** Everything that came from a thread is listed under it, in the order opened: side questions ↳, side questions made their own threads ↗, threads split off at a question ↪. A merged thread keeps its mark and adds ⤶. A family moves to the top when anything in it is asked in.

## Verified

| Check | Result |
| --- | --- |
| `node --test` (sandbox and founder's Mac) | 158 pass. New: one box holding a heading, a paragraph and a list becomes three blocks (same request twice adds nothing); an edit that adds a heading and a paragraph inserts them after the block; a code fence with a blank line stays one block; an AI section is one suggestion and three blocks once accepted ("added 3 AI blocks"); old blocks holding several are split at start-up, once, keeping their author. The search test now writes a single paragraph (its old heading + paragraph block is two blocks now) |
| Playwright (sandbox, Chromium) | 35 pass, twice in a row. New: a hand-written note with four paragraphs gets a catalog by first sentence; a heading-and-text note gets a heading catalog; an AI section lands as three blocks and its heading joins the catalog; a side question made its own thread and a thread split off stay under their origin after newer activity elsewhere, and the family moves up when asked in. The side-question test now expects the own thread nested with ↗. Every spec now uses the shared wait for a question's own answer (the old one made the catalog spec time out once in a full run) |
| `tsc` on core, server, web and root (founder's Mac) | Clean |
| Screens | The sidebar before and after with the same threads; a hand-written Chinese note's block catalog |
| Founder's notebook | His `pnpm dev` restarted and split the blocks holding several: one note 144 → 149 blocks, another 2 → 6 blocks (2 headings, so it now has a catalog); no text changed. Copy before: `data/backups/noema-before-block-split-2026-11-06.db` |

## Not verified

- `pnpm lint` (Biome) still not run here; please run it with `pnpm e2e` on the Mac.
- The wider suggestion prompt has not been tried with DeepSeek; only the fake model.

## Next

- Try "Ask AI" in a note with "write a section on …" and accept it.
- M3 sources, then M5.
