# 0017. Ask again: every answer kept, one in use

Date: 2026-11-07. Status: accepted.

## Context

M5 in the prototype brief: regenerate, with anchors and side questions still valid. The rule in AGENTS.md already said that regenerate makes a new revision and never edits one; the store had revisions (`message_revision`, `message.current_revision_id`) but nothing made a second one.

The questions were what a new answer replaces, what a side question asked from the old answer then sees, and which answer later questions are asked with.

## Decision

- **A new revision, never an edit.** `POST /api/messages/:id/regenerate {revisionId}` adds a revision (the client makes its id, so sending twice asks once), makes it the one in use and answers it with the same context a first answer would get (the conversation before the question). Refused while the answer is still being written or the thread is in the Trash. A failed, stopped or interrupted answer can be asked again the same way, which is also how a failed answer is retried.
- **One revision in use.** It is shown first, searched, and sent with new questions. `GET /api/messages/:id/revisions` lists them all; `POST /api/messages/:id/current` makes another the one in use (search is updated). Later questions already asked keep what they were asked with, and What was sent shows it (`/context?revision=` for any revision).
- **Side questions stay with their revision.** An anchor points into one revision, so a side question asked from the first answer still points at it. Its inherited conversation uses that revision of the answer it came from, even after the answer is asked again (the other answers before it are the ones in use). A side question can also be asked from an earlier answer read again: `CreateBranchRequest.anchor.revisionId`.
- **In the app.** **↻ Ask again** under a finished answer. An answer asked more than once has a ‹ 1 / 2 › switch that stays visible; reading an earlier one says so, with **Use this one**. Back from a side question shows the answer it was asked from, at its passage, if that is an earlier one. The fake model adds "Asked again: this is answer N." so tests can tell answers apart.

## Consequences

- A note's citations (`[E3]`) point at an exchange, not a revision: after asking again, a citation shows the answer in use. Pinning citations to the revision cited is left for later.
- A merge's summary was written from the answers in use at the time; it is not redrafted when an answer is asked again.
- Nothing is deleted: every answer stays in the store and in exports.

## How to reverse

Remove the button and the three routes. Revisions already made stay valid: each is an ordinary row of `message_revision`, and the one in use is the one shown.
