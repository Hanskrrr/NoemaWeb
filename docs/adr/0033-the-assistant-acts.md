# 0033. The Assistant acts, in as many steps as it takes, and says less

Date: 2026-11-18. Status: accepted.

## Context

On 2026-11-18 the founder said he wants it to be "like an agent" that does things "multiple rounds automatically". His three complaints:
- The Assistant's references and sources are too redundant.
- Clicking Do it on each change is tiring.
- It cannot do several operations in one go.

His notebook bears this out (counts only):
- Answers citing 8 to 32 labels, sometimes many for the same few things (26 labels for 7 things). Each cited label was a card under the answer.
- Answers proposing 11 changes, each tapped Do it one by one (11 unlinks; 6 put in rooms with 3 to the Trash).
- At most 4 calls a round. A change was only a proposal, so a later step could not build on it (make a room, then put things in it).

ADR 0024 had the Assistant propose and the learner confirm each change, and ADR 0029 kept that for its room and link powers. When he asked for "all permissions" (ADR 0029), we told him to say so if he meant acting without asking. He now has.

## Decision

- **It acts on its own.** A change is done when the model calls it, through the same `AssistantActions.run` as Do it. The model is told what happened: "Done: …", or why not.
  - A change that makes something (a thread, a note, a source, a note from a file) gives it a label, so the next step can use it. This is how a request of many steps is done in one answer.
  - The prompt and the tools say the changes are done at once and can be undone (`ACTING_PROMPT`, `ACTING_TOOLS`). It is asked to do all the learner asked, in as many steps as it takes, to make changes that do not depend on each other in one round, and to say briefly what it did.
- **What still waits for Do it**:
  - Writing files on the learner's computer (`WAITING_KINDS`: `write_file`, `edit_file`, `save_note_to_file`). Other apps use those files, and Undo cannot help once something else has changed one.
  - More than three changes in one answer that start another answer of the model (`ANSWERING_KINDS`: questions, notes written from a thread, merges; `MAX_NEW_ANSWERS`), so one request does not spend many calls.
  - Notes it writes still arrive as suggestions the learner accepts in the note (ADR 0007).
- **More steps.** 16 rounds (from 6), 10 calls a round (from 4), at most 40 changes an answer. The context budget still ends the rounds when it is reached. The same change asked twice in one answer is done once.
- **Undo for all of it.** Each change has Undo, as before. An answer with more than one change has a line saying what it did ("Did 5 things"), with Undo all (newest first; a change that cannot be undone any more is left and said so) and Do all for what waits. A list of more than four changes folds to the ones that need the learner, with "Show each".
- **Asking first is a setting** of the notebook (`notebook.assistant_asks`, migration 025): "Acts itself" / "Asks first" in the Assistant's header. Asking first, everything waits for Do it as before.
- **It says less.**
  - Cited things are one card per thread, source or note, however many of its places are cited, and only the first three show ("2 more from your notebook").
  - The model is asked to cite the one or two places that best support a point, and a thing once in a paragraph.
  - The lookups fold to "Looked up 9 times ▸" after the answer, and to the newest three while it works.
  - In a room's thread, only the pages from the web that the answer cites stay on offer, at most three (ADR 0031 offered all five found).
- Tests use the fake model. `$made` in a `[[call:…]]` is the label of what the last change made.

## Consequences

- A wrong reading of a request now changes the notebook before the learner sees it. Undo and Undo all are the way back, and the changes are listed under the answer. "Asks first" is one click away.
- Deleting a room or moving things to the Trash happens at once too, with Undo (the Trash keeps them).
- An answer that does a lot takes longer and costs more calls: each round is one call. Most of the conversation is cached between rounds.
- Not tried with DeepSeek yet: whether it chains steps well, cites less, and stops when done.

## How to reverse

Set "Asks first" (or default `assistant_asks` to 1 in a migration), or have `Generations.propose` always store a proposal. The limits are constants in `packages/core/src/assistant.ts`. The folding is in `Assistant.tsx` and `MessageView.tsx`.
