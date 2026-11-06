# 0007. Notes are blocks; AI suggestions wait; a split thread keeps only its passage

Date: 2026-11-06. Status: accepted.

## Context

The founder's first real note ran to 16,000 characters across two subjects, because a side question had drifted into a new subject. Editing it meant one large Markdown textarea. He asked to edit in place (like Jupyter), to rewrite one paragraph with AI, to insert a written or AI paragraph anywhere, to split a note, and to make a side question its own thread with its own map and notes.

## Decision

- **A note is an ordered list of blocks** (`note_block`): a paragraph, heading, list, table, quote, fenced code or display math. `splitBlocks` in `packages/core` makes them from Markdown (blank lines separate blocks, except inside fences and `$$`; a list continues across blank lines; a heading is its own block). `note.content` keeps the blocks joined, for export and the notes list. Joining what was split gives back the same text; the founder's note came back byte for byte.
- **Each block records who wrote it**: `ai`, `user` or `ai+user`. The page shows it as a rule on the left.
- **The AI never changes a block by itself.** "✦ AI" on a block, or "Ask AI" between blocks, writes a *suggestion* (`proposal`, `proposal_status`) next to the block, streamed by the server like answers. The learner replaces, discards or tries again. A block added by "Ask AI" stays empty, and out of the note's text, until accepted.
- **Every change is a version** in `note_revision`, with what changed and a snapshot of the blocks. Deleting a block is soft (`deleted_at`), so Undo puts it back where it was.
- **Citation labels stay stable.** When the AI is asked about a note later, exchanges it already cites keep their labels and new exchanges get new numbers, so `[E3]` keeps meaning the same exchange.
- **Splitting a note** moves a section, or a block and everything below it, into a new note with the same thread and citation map.
- **A side question made its own thread** (`thread.split_at`) is listed at the top level, has its own map and notes, and is left out of its parent's map (shown as a link) and notes. New questions in it send only the passage it came from, not the parent conversation. It keeps its origin, so Back still works, and "Put back" undoes it.

## Consequences

- Block-level identity makes per-block AI help, provenance and concurrent suggestions simple. The cost is more endpoints and one more table.
- A note of 170 blocks is a long page of small blocks. Rendering is fine at this size; virtualising would come later if notes grow much larger.
- Editing across two blocks at once (merging, selecting across) is not possible yet. Moving and splitting cover the common cases.
- A split thread's earlier answers were given with the parent conversation; its later answers are not. That is the point of splitting, but a learner who wants the old context should keep it as a side question.

## How to reverse

Blocks: drop `note_block` and treat `note.content` as the note again (it is always kept up to date). Split: clear `thread.split_at`; nothing else depends on it.
