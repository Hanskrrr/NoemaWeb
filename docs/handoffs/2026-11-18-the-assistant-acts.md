# Handoff 2026-11-18: the Assistant acts, and says less

The founder said:
- the Assistant's references and sources are too redundant;
- clicking Do it on each change is tiring;
- too many things show under each answer;
- it cannot do several operations at once;
- it should be like an agent that goes on in rounds by itself.

His notebook showed the same, as counts:
- 8 to 32 cited labels an answer, each a card (26 labels for 7 things);
- 11 changes in one answer, each tapped Do it.

ADR 0033 records the decision. Round 5 of the rooms work (the map by meaning) waits; it was not started in code.

## What changed

- **Core.**
  - `assistant.ts`:
    - `MAX_LOOKUP_ROUNDS` 16, `MAX_LOOKUPS_PER_ROUND` 10, `MAX_CHANGES` 40, `MAX_NEW_ANSWERS` 3;
    - `WAITING_KINDS`, `ANSWERING_KINDS`, `MAKING_KINDS`;
    - `ACTING_TOOLS`, whose change tools say "Done at once…" (file writes: "It waits…").
  - Contract: `Notebook.assistantAsks`, settable through `PATCH /api/notebooks/:id`; `UndoAllResponse`.
- **Server.**
  - Migration 025: `notebook.assistant_asks`.
  - `generation.ts`:
    - `propose` runs a change at once when the Assistant acts on its own, or stores it as a proposal;
    - it tells the model "Done: …" with a label for what a change made, "Waiting for the learner…", or why it failed;
    - the same change twice in one answer is done once;
    - `ACTING_PROMPT`;
    - after an answer in a room thread, only the web pages it cites stay on offer (`keepCitedWebFinds`, `citedWeb`).
  - `AssistantActions.runAll` / `undoAll`, with routes `POST /api/messages/:id/actions/run-all` and `/undo-all`.
  - The `Generations` instance gets the actions through `useActions`.
  - Fake model:
    - `$made` in `[[call:…]]`;
    - it cites the web pages it was given, or those `[[web-cites:2]]` names;
    - the question after the pages is what it echoes.
- **Web.**
  - The Assistant's header: "Acts itself" / "Asks first" (App keeps it, saved on the notebook).
  - Cited things: one card a thing, the first three, "n more from your notebook".
  - Changes: a head line ("Did 5 things", "2 wait for you") with Undo all and Do all. More than four fold to what needs the learner, with Show each. What is open is drawn again after a burst of changes.
  - The lookup trail folds: "Looked up 9 times ▸" after the answer; the newest three while it works.
- **Tests.**
  - Tests of proposals set "Asks first" in their setup (assistant-actions, rooms, rooms-in-rooms, room-reading, folders).
  - `assistant-acts.test.ts` is new:
    - done and undone;
    - many steps with labels of what was made;
    - more than four changes at once, and the same change once;
    - three questions on its own, the fourth waiting;
    - Do all and Undo all;
    - the setting.
  - folders: acting on its own, a file write still waits.
  - room-reading: only cited web pages stay.
  - Core: the acting tools.
  - e2e:
    - acting itself, with the cards folded to three, one change opened and undone, five folded with Undo all;
    - asking first, with Do it and Do all.

## Verified

- 354 unit tests and 84 e2e tests in the sandbox; tsc clean for core, server, web and the root.
- Screenshots of an answer with five changes (folded, then each shown) and five cited sources (three shown) looked right.

## Not verified

- DeepSeek: whether it chains steps well with the labels it is given, cites less, and stops when done.
- Biome; Safari.

## Next

- The founder tries it with DeepSeek on his notebook: a request of several steps (make a room, file things in it, link them), then Undo all.
- Round 5 of the rooms work: the map by meaning.
