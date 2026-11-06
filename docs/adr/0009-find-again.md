# 0009. Finding things again: one derived index, and what "left open" means

Date: 2026-11-06. Status: accepted.

## Context

M4 is "find again": a search term must open the exact message, even inside a side question (acceptance test 5), and a learner who never writes a note must still get everything (acceptance test 1). By now a notebook also holds notes made of blocks, and every answer has a headline. The insights handoff adds "side questions you didn't come back from" when Noema opens.

## Decision

- **One FTS5 table for everything**, as before: thread titles, questions and answers, and now note titles and note blocks. An answer is indexed with its headline, so a line that says the point in other words (often in the learner's language) finds the answer. Notes are indexed as plain words: no citation labels, no Markdown marks. Every note change reindexes that note, from the one place every change already passes through (`syncNote`).
- **The index is derived, never a source of truth.** It carries a version (`meta.search_index`, migration 008). When the code's `SEARCH_INDEX_VERSION` is higher, start-up rebuilds the whole index from the stored text in one transaction. Changing what is indexed means raising the number, not writing a migration.
- **A hit says where it is**: the threads above it, whether it is a question, an answer, a title or a block, and when. A thread's or note's title is shown as its own hit only when nothing inside matched. Opening a hit goes to the exact message or block and marks the words searched for there (CSS Custom Highlight API); the first is centred, so a long answer opens at the matching line.
- **"Left open"** is computed from what happened, not stored: a side question with an answer, not made its own thread and not merged back, with nothing after its last exchange that took the learner back: no Back to the passage, no later question in the thread above, and no "Not now". Asking in it again opens it again. "Not now" is an event (`branch.set_aside`), like Back.
- **Where Noema reopens**: the last place open in this browser (kept in local storage), unless a thread has had something newer since; then that thread.
- **What is logged**: opening a hit logs its kind, rank and the query's length (`search.opened`), never its words, for the brief's measure "searches that end on the right message".

## Consequences

- Each note change deletes and reinserts that note's rows; the FTS columns that name the owner are unindexed, so this scans the table. Fine at notebook scale (thousands of rows); revisit if typing in a long note ever feels slow.
- Merged texts are not indexed on their own: what they say is in the source thread, which is.
- A rebuild at start-up blocks the server for its duration (well under a second for the founder's notebook).

## How to reverse

Drop the 'note' and 'block' rows and the headline from `rebuildSearch`, and raise the version. The left-open list is a query and two routes; removing them changes no stored data.
