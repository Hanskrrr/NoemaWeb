# 0008. Merging threads adds, never rewrites

Date: 2026-11-06. Status: accepted.

## Context

After splitting came the wish to merge: fold a side question back into the thread it came from, or bring two parallel threads together, "like a squash in git", perhaps by rewriting the child into the place it diverged. Notes made of blocks should merge too.

## Decision

- **A thread merge is a merge commit, not a rebase.** Nothing already said is changed. The AI drafts what the source found (or the source's exchanges are taken as they are); the learner edits and accepts the draft. From then on the draft goes **in front of the target's next question**, every time, so the conversation before it stays the same prompt prefix and the provider's cache stays warm (`thread_merge.after_seq`, `HistoryItem.merged`, `assembleContext.mergedNow`). Its citation labels are taken out for the model; they belong to the source.
- **Where it is read and where it is sent differ on purpose.** The card shows under the passage a side question came from (or after the target's last message, for any other thread), while the model receives it from the moment of merging. Earlier answers stay what they were: written without it.
- **Undo** stops sending it and hides the card. The source thread is never removed; it is marked merged.
- A thread is not merged into one of its own side questions (they already inherit its conversation), nor while its answer is still being written.
- **Notes merge by moving blocks**: the other note's blocks are inserted (at the end by default), its citation labels renumbered where they clash so each still opens its exchange, and the other note removed.

## Why not rewrite

- The transcript would misstate what the model saw: answers after the insertion point were written without the merged content.
- Anchors (side questions, highlights, note citations) point at exact characters of exact revisions; rewriting messages breaks them. Revisions are immutable by rule.
- Side questions below a squashed child would lose their parent.
- Inserting in the middle sends a different prefix: the next request misses the cache from that point on, once per merge. That is a cost, not a correctness problem: the provider keeps no state between requests beyond the cache.

## Consequences

- The target carries the merged text in every later request; a long merge costs tokens each time (cached after the first). The "whole exchange" mode is capped at 20,000 characters, and at most 12,000 are sent.
- A source renamed after merging changes the merged text's heading, so the next request misses the cache once.

## How to reverse

Drop `thread_merge` and the `merged` handling in `history()`; threads and notes are unchanged by merges, except note merges, which moved blocks (their versions are in `note_revision`).
