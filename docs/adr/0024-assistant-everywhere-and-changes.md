# 0024. The Assistant everywhere, with cards, quotes, and changes the learner confirms

Date: 2026-11-13. Status: accepted.

## Context

After step 1 (ADR 0023) the founder asked for more than reading:

- that the Assistant can "use the tools to operate the whole Noema";
- that threads, sources and notes it mentions are in the conversation, one click from where they are;
- that it can quote the very text, shown in a panel to preview;
- that it is "anywhere in the noema, not only that one single page".

Asked how it should act, he chose: **ask me first**. Each change is a card with Do it / Cancel, with Undo after. Opening things and taking him somewhere need no asking. He chose all four kinds of change: threads, notes, organizing, sources.

PARADIGM §5 still holds: no model process silently changes the learner's writing. Text for a note arrives as a suggestion the learner accepts in the note.

## Decision

- **Beside whatever is open.** The Assistant is a panel on the right, next to any thread, source or note. It opens with ⌘J (Ctrl+J), the Assistant button in the header, or the orb on the rail, and stays open across pages and reloads. ⤢ opens it on a page of its own (`#/assistant`); opening something from there brings it back beside it. The light around the window is on while it is open. Under 760 px it lies over the page.
- **It knows where the learner is.** Each question carries what is open (thread, source or note) and any text selected there (`AskRequest.place`, kept in `message.place`, migration 017). The server finds the selection in what is open and labels it, so "this" means it. The panel shows it above the box, and it can be removed with ×. The selection is dropped after asking, and when the place changes.
- **Cards and quotes.**
  - Under each answer, every label it cites is a card: what it is, its title, and the words it quoted, or the start of the text.
  - The model is told to quote exact words in quotation marks or as a `>` quote, then the label.
  - When the answer ends, each quote is checked against the original. White space does not count, and `…` stands for words left out. Only a quote that is there is kept, with the text around it (`VaultTarget.quote`, `.excerpt`); a quote of a source moves the target to where the words are.
  - Clicking a card (or a label in the text) opens a preview in the panel with the quote marked. **Open there** goes to the message, passage or block, with the quoted words marked on arrival.
- **Show.** A `show` tool takes the learner to a thread, a passage (a PDF at a page) or a note at once. It is a done action, and the panel follows it as it happens, once.
- **Changes are proposals.** There are fourteen change tools:
  - threads: `start_thread`, `ask_in_thread`, `ask_about_passage`;
  - notes: `create_note`, `add_to_note`, `change_note_block`, `note_from_thread`;
  - organizing: `rename`, `pin`, `unpin`, `merge_threads`, `move_to_trash`, `restore`;
  - sources: `add_source`.

  Each is checked when the model asks for it: arguments, labels, and quoted words resolved to ids and offsets in the stored text. It is then kept as a proposal (`assistant_action`, migration 017) and sent to the panel as it is made. The model is told it was proposed and that nothing has happened. Something that cannot be done (an unknown label, words not in the text, a source passage with no thread to pin it to) is told back to the model and not proposed.
- **Do it, Cancel, Undo.**
  - Do it runs the change through the same store calls as the app's own buttons. A second tap does nothing more.
  - What it made is kept, so the card offers **Open** and, where it makes sense, **Undo**. Undo moves a new thread, note or source to the Trash, removes an added block, discards a suggestion, renames back, unpins or pins again, discards or undoes a merge, or restores. A thread still answering is stopped before it goes to the Trash.
  - Asking in a thread cannot be undone: the question is in the thread.
  - After a change, what is open is drawn again, so it shows the change.
- **Not "asked before", not a thread to import over.** The Assistant's thread is made when Noema opens. With nothing asked in it, it does not count as content for an import into an empty Noema.

## Consequences

- A proposal names what it will do in one line ("Pin “a shard of the batch” to “Data parallel”"). The learner decides from that line; the details are in What was sent.
- Changes are only as good as the model's choice of labels and words. Checks refuse what does not resolve, but a wrong but valid label (pinning to the wrong thread) is possible. That is why every change waits for Do it, and most can be undone.
- Quotes that are not exactly in the original lose their quote (the card shows the start of the text instead). Paraphrase is not checked.
- Remounting what is open after a change resets its scroll position.
- The scope fence: this is the founder's decision (ADR 0023's fence notes are widened in AGENTS.md).

## How to reverse

Drop the change tools from `ASSISTANT_TOOLS`. Proposals already made can stay in the table. Remove the dock from `App.tsx` to keep the Assistant on its own page only.
