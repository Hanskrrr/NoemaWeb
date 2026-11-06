# 0010. A new thread from a question moves the messages, never copies them

Date: 2026-11-06. Status: accepted.

## Context

A thread drifts: it starts on one subject and ends on another, and its note mixes both. Side questions could already be made threads of their own (ADR 0007), but the main line of a thread could not be cut. The founder asked to "make a whole other thread from a certain ask".

## Decision

- **Cut at a question, and move.** "New thread from here", on any question after the first, moves that question and everything after it into a new top-level thread. The messages keep their ids, revisions, text and anchors; only `message.thread_id` and `seq` change (the new thread numbers from 0). Copying was rejected: two copies of an exchange would split its side questions, citations and search hits between them.
- **Everything that points at a moved message by thread follows it**, in the same transaction: side questions asked from the moved messages (`parent_thread_id`), merges accepted after the cut (`target_thread_id`, `after_seq` renumbered), earlier split-offs from the moved part, citations in notes, note versions and merges (`refs` name the thread), and the search index. A note rewritten from the original keeps its `thread_id`; its citations still open the right exchanges.
- **The new thread is its own.** It records where it came from (`thread.continued_from`, `continued_at_seq`; migration 009) but sends only its own exchanges to the model, like a side question made its own thread. The original stops sending the moved part. The model titles the new thread from its first exchange.
- **Join back undoes it exactly**: the questions go back at the same places, everything that followed them goes back too, and the new thread is removed. It is allowed only while the original has nothing after the cut (no new questions), and while neither has a merge with the other; otherwise the page says why and offers nothing destructive.
- Not while an answer is being written in the thread.

## Consequences

- `message.thread_id` and `seq` are no longer fixed for a message's life. Code must find a message's thread from the row, never from where it was first asked. Anchors, revisions and manifests never named the thread, so they are unaffected.
- Old model-call manifests list the exchanges as they were sent, which may now be in another thread. That is the record of what happened, and stays.
- The next question in either thread misses the provider's prompt cache once (the prefix changed).
- Only "from here to the end" for now; cutting out a middle range would leave the original's later answers written with context it no longer has.

## How to reverse

Join back every split-off thread, then drop the two columns. No stored text changes either way.
