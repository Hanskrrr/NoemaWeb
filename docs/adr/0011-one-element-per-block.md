# 0011. A block holds one element; text holding several becomes several blocks

Date: 2026-11-06. Status: accepted. Refines [0007](0007-notes-are-blocks-and-split-threads.md).

## Context

Notes are made of blocks (ADR 0007). A note rewritten from a thread is split into one block per paragraph, heading, list, table, code or math block. But text the learner wrote in one box, and text the AI wrote when asked, stayed one block however much it held. One of the founder's notes, asked of the AI, was two blocks holding six elements: no catalog, and no way to edit, move or rewrite one paragraph of it. The AI was also told to write "exactly one block".

## Decision

- **One element per block, everywhere.** When the learner saves a block, writes a new one, or accepts an AI suggestion, the text is split with `splitBlocks` (blank lines separate blocks, except inside code fences and `$$` math; a list continues across blank lines; a heading is always alone). The first part keeps the block's id; the rest are new blocks right after it. A save is still one request and one version.
- **The AI writes as much as it is asked.** A suggestion is still reviewed as one unit (accept or discard it whole); accepted, it becomes as many blocks as it holds. A rewrite keeps to what the block covered, and may become two blocks.
- **Existing blocks holding several elements are split at start-up**, with their author kept. Afterwards none can hold several, so it happens once.
- **Catalog of a note**: its headings when it has two or more; otherwise, from four blocks on, every block by its first sentence.

## Consequences

- A learner cannot keep two paragraphs together in one block. That is the cost of every paragraph being editable, movable and rewritable on its own, and of headings always reaching the catalog.
- Joined back with `joinBlocks`, a split note reads the same as before.

## How to reverse

Stop calling `splitBlocks` in `insertBlock`, `editBlock`, `acceptProposal` and `recoverNotes`, and restore the old prompt line. Split blocks stay split; nothing is lost either way.
