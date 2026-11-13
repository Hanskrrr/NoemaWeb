# Handoff 2026-11-13 (later): the Assistant everywhere, with cards, quotes and changes to confirm

The founder asked whether the Assistant can operate the whole of Noema. He also wanted what it mentions embedded in the conversation, one click away; exact quotes he can preview in a panel; and the Assistant available everywhere, not on one page. He chose **ask me first** for changes (a card with Do it / Cancel, then Undo), and all four kinds: threads, notes, organizing, sources. Decisions are in [ADR 0024](../adr/0024-assistant-everywhere-and-changes.md); step 1 is in the earlier handoff ([2026-11-13-assistant](2026-11-13-assistant.md)).

## What changed

- **Beside whatever is open.** The Assistant is a panel on the right of any thread, source or note. It opens with ⌘J (Ctrl+J), the **Assistant** button in the header, or the orb on the rail, and stays open across pages and reloads. ⤢ gives it a page of its own; opening something from there brings it back beside what it opened.
- **It knows where you are.** Each question carries what is open and the text selected there. The line above the box shows it, and × removes the selection. The server finds the selection in what is open and gives it a label (migration 017 adds `message.place`).
- **Cards and quotes.**
  - Under each answer, everything it cites is a card: the kind, the title, and the words it quoted.
  - A card, or a label in the text, opens a preview in the panel with the quote marked. **Open there** goes to the place, with the words marked.
  - Quotes are checked against the original when the answer ends; one that is not there is dropped.
- **It takes you places.** `show` opens a thread, a passage (a PDF at a page) or a note at once.
- **It proposes changes.**
  - There are fourteen: start a thread, ask in one, a side question on a passage; make a note, add to it, a new version of a block, a note from a thread (text in notes always arrives as a suggestion to accept); rename, pin, unpin, merge, move to the Trash, restore; add a source.
  - Each is checked when the model asks for it, with labels and quoted words resolved to ids and offsets. It is kept as a proposal (`assistant_action`, migration 017) and shown as a card while the answer is written. Nothing happens until **Do it**.
  - Then **Open** and, where it makes sense, **Undo**. What is open is redrawn to show the change.
- **Code.**
  - New: `chat/actions.ts` (plan, run, undo), `Assistant.tsx` (the panel and the page), and the quote and place functions in core.
  - `ThreadView.tsx` is back to what it was before the Assistant.
  - The fake model can call any tool (`[[call:NAME:JSON]]`) and quote (`[[quote:WORDS|N]]`).
- **Fixed on the way:** an Assistant with nothing asked in it no longer makes a Noema count as not empty, which had stopped imports.

## Verified

| Check | Result |
| --- | --- |
| `node --test`, sandbox | 285 pass. New, core: quotes found near a label (quotation marks, Chinese brackets, `>` paragraphs) and checked (white space, `…`); change arguments. Server: a proposal is not done until run; run once; open and undo; cancel; refusals told to the model and not proposed; a side question on a source passage, asking in a thread, renaming, pin, unpin and pin again by undoing; note suggestions, a block's new version, a note from a thread; merge, the Trash and back (by the Trash's labels), adding a source, show; quotes kept only when there, with the text around them; where the learner is and the selection in the question; import after the Assistant was made |
| Playwright, sandbox | 67 pass. New: beside a source with a selection, lookups, the card's quote, the preview marking it, Open there; a change waiting for Do it, Open, Undo (the thread shows it is in the Trash), show; the frame through its states and off when closed; reduced motion; the page of its own; not in the thread list |
| tsc | Core, server, web and the root project clean in the sandbox |
| By eye | Screenshots in light mode of the panel beside a source with a selection, an answer with cards and two proposals, the preview, and a done change opened; a 23-second recording in dark mode |

## Not verified

- **DeepSeek.** All with the fake model. Not seen yet:
  - whether `deepseek-flash` picks the right labels for changes and quotes words exactly;
  - whether it proposes only what was asked;
  - whether it handles 18 tools well, and in thinking mode.

  The tool descriptions and the instructions say to propose a few at a time and never claim a change is done.
- **Biome.** Not run here.
- **His screen.** On a narrow window the panel takes room from the reading pane and the thread beside it; under 760 px it lies over them.
- **The fake's markers.** In the recording the questions show the fake model's `[[…]]` markers. With DeepSeek you just ask in words.

## Follow-up the same day: the catalog and the panel's width

- The founder found that the catalog (the ticks on the right of a long thread or note) lay under the panel, and that the panel's width could not be changed.
  - The catalog is fixed to the window's right edge. It now moves over by the panel's width (`--dock-width`, set by the app). What is open keeps a strip on its right for it while the panel is open.
  - The panel's left edge can be dragged, from 300 px up to 60% of the window. The arrow keys also work when it has focus, and a double-click gives the usual 432 px. The width is kept across reloads.
- Checked: 285 unit tests; 68 end-to-end tests, the new one dragging the edge, checking the catalog stays clear, reloading and using the keyboard; a screenshot of a thread with its catalog beside the panel.

## What's next

1. On the Mac: pull (`pnpm dev` restarts and adds migration 017), open a deck, select a sentence, press ⌘J, and ask "Explain this" and "Make a note of this". Then ask "Start a thread about what I didn't understand in Week 4" and try Do it and Undo. Tell me which proposals were wrong.
2. Then decide step 2 (memory items) against M6.
3. Still open: pushing (with the lockfile), `pnpm asked:check`, PDF pages with DeepSeek.
