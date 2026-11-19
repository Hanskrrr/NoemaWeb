# 0034. Deleting for good, from right-click

Date: 2026-11-19. Status: accepted.

## Context

On 2026-11-19 the founder asked to be able to right-click a note, source or thread to delete it permanently. Until now, deleting only moved things to the Trash (ADR on the Trash: hidden everywhere, kept as they were, back with Restore). Nothing was ever removed, and the Trash had no way to empty it.

## Decision

- **Right-click** on a thread, source or note offers two things at the end of its menu, wherever it is listed: the sidebar's lists, "In no room yet", and a room's cards.
  - **Move to the Trash**, with Undo in the line at the bottom, as the buttons in each view do.
  - **Delete forever…**, in red.
- **Things in the Trash** can be right-clicked too: Restore, or Delete forever….
- **Delete forever asks first, in the menu's place.** The menu says what goes, what stays and that it cannot be undone. Cancel has the keyboard; the red button does it. A new menu item kind does this (`confirm` in `ContextMenu.tsx`), and it can serve other things that cannot be undone.
- **What goes** (`purgeThread`, `purgeSource`, `purgeNote`, `DELETE /api/…/:id/forever`):
  - A thread goes with the side questions still its own, at any depth, in the Trash or not. Its messages, every answer, passages, pins, merges and the Assistant's changes made in it go with it, by the cascades already in the schema. If it was merged into another thread, what was merged goes from there too, and the menu says so.
  - A source goes with its versions, passages, page pictures and pins.
  - A note goes with its blocks and history.
  - For each: its places in rooms, its links, its summaries and its words in search go.
- **What stays lets go of it.**
  - A side question made its own thread stays, no longer under it. Side questions started on its words lose that tie.
  - Threads asked about a source stay, no longer tied to its passage.
  - Notes made from a thread stay; their citations of it show as not found, as any lost anchor does.
  - What was in a room only because it came with the deleted thing stays in that room, now on its own: a source's threads, a thread's notes.
  - A page found on the web and added as the source is offered again.
  - Files on the learner's computer are never touched; the menu says so for a source that is a file.
- **Refused:** a thread whose answer is still being written, a note still being written, and the Assistant's own conversation.
- The Assistant is not given this power. Acting on its own (ADR 0033), it can still only move things to the Trash, with Undo.

## Consequences

- What is deleted for good is gone from the notebook and from future exports. Older copies stay where they are: the daily database backups in `data/backups` (the last seven days) and any export already made.
- The event log keeps that something was deleted (ids only, as every event).

## How to reverse

Remove the two items from `deleteItems` (`itemMenu.ts`) and the three routes. Nothing else depends on them.
