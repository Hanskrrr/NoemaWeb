# 0012. Deleting puts things in the Trash; nothing is removed yet

Date: 2026-11-06. Status: accepted.

## Context

The founder asked to delete threads and notes. Notes could be deleted, for good; threads could not. A thread is tied to much else: side questions asked from it, side questions that became their own threads, threads split off from it, merges it gave or received, notes rewritten from it and their citations. PARADIGM §7 asks that reorganising durable content be reversible and keep origins.

## Decision

- **Delete means the Trash.** `thread.deleted_at` and `note.deleted_at` (migration 010). A thing in the Trash is hidden from the sidebar, search, maps, merge pickers and the side questions left open; it can still be opened and read, marked, with no box to ask in; asking, branching, merging, splitting and editing are refused (409) until it is restored. Nothing is removed from the database.
- **A thread takes its own side questions along** (those not made their own), marked `deleted_with` so they come back together. Threads that became their own (↗, ↪) stay: they are their own. Merges stay where they were merged, notes stay, citations stay.
- **Restore brings back exactly what went.** Restoring a side question whose thread is in the Trash too brings that thread back as well, so a side question is never shown without where it came from.
- **Undo** right after (a toast, 8 seconds), and **Restore** from the Trash at the bottom of the sidebar.
- Notes were deleted for good before; they now go to the Trash too.

## Consequences

- The database keeps growing with what was deleted. Fine for one learner's notebook.
- There is no "delete for good" yet. Removing a thread for good needs care: side questions that became their own threads point at it by a foreign key that would remove them too, merges from it would vanish from the threads they were merged into, and citations to it would dangle. Recorded in `ideas.md`.

## How to reverse

Restore everything, then drop the three columns.
