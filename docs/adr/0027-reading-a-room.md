# 0027. Reading a room: summaries, links to the words, links between things

Date: 2026-11-13. Status: accepted.

## Context

After rooms (ADR 0026) the founder found three things rough:
- the version as a whole;
- the Assistant could not help with rooms;
- the things in a room did not look related.

He proposed that the AI process what is in a room: a brief summary of each, with links back to the original, and the relationships between them, which he can edit himself.

We agreed it was rough, for three reasons:
- a card showed a title and counts, not what the thing says;
- lines came only from links that happened by the way (a pin, a split, a citation), so most rooms had none;
- the Assistant was not told which room was open.

His proposal fixes the first two. It is also the "Link" part of the study structure drafted on 2026-11-12: a kind, who made it, and whether it is a fact, suggested, kept or dismissed.

The scope fence lists knowledge graphs and concept extraction. Links suggested by the AI, kept only when the learner keeps them, are his decision, recorded in AGENTS.md.

## Decision

- **Read with AI**, a button at the top of a room. It runs only when pressed, because it spends the learner's model credit.
- **Summaries.** It writes a summary of each thing in the room that has none, or whose summary was written before the thing changed (migration 020, `gist`). A summary is one or two sentences and up to three key points. Each point quotes the original word for word.
  - The quote is checked against the original (`findQuote`, white space aside, as with the Assistant's quotes).
  - A quote that is found becomes a link to the exact place: a source at that offset, a thread at that message, a note at that block. A point whose quote is not found is shown without a link.
- **What the model reads:**
  - a source: its latest version;
  - a thread: its questions and answers, then its side questions;
  - a note: its blocks.

  The first 14,000 characters go to the model.
- **Freshness.** A summary keeps what it was written from: a source's version, or when a thread or note last changed. It is shown as older until the room is read again. Summaries belong to the thing, not the room.
- **Suggested links.** Then the AI reads all the summaries in the room, numbered, and suggests links (`item_link`, made by `ai`, status `suggested`), each with a reason. The kinds:
  - explains;
  - is an example of;
  - builds on;
  - contrasts with;
  - asks the same as;
  - is part of;
  - is related to (rarely).

  It is told which pairs are linked already. A pair that has a link in any state, dismissed included, is never suggested again.
- **Links are the learner's to keep.** On the map, a link is a line from card to card with an arrow and its words: dashed with a question mark while suggested, solid once kept. Clicking the words opens the editor:
  - **Keep**;
  - change the kind, or give your own words (changing a suggestion keeps it);
  - **Turn around**;
  - **Dismiss** (kept as dismissed, so it does not come back), or **Delete** a kept one.

  **Link to…** (right-click a card, then pick the other card) draws one by hand. Links belong to the notebook and show in every room holding both ends. Pointing at a card brings its links forward and fades the rest.
- **The Assistant knows the room.**
  - A question asked with a room open carries the room's things (labelled, with their summaries) and its links.
  - It proposes `link` (two labels, a kind, its own words if needed) and `take_out_of_room`, besides `put_in_room`.
  - Each waits for Do it and can be undone (ADR 0024).
- Progress (summarizing n of m, then looking for links) is kept by the server and shown in the room, which asks again until it is done. A model that is not connected, out of credit or failing is said in words; the summaries already written are kept.

## Consequences

- Reading a room costs a model call per thing that needs a summary and one more for the links. Things already summarized and unchanged cost nothing.
- Links are suggested from summaries, not from the whole texts. That is cheaper, and the learner can see what the AI saw, but it misses links that only the details show.
- The map gets busier with links. Fading the links not at hand is the only help so far; a room of many links will want filtering (only kept, only one kind).
- Summaries of PDFs read the PDF's text, not its pictures.
- Not tried with DeepSeek yet: how good the summaries and links are, and how often quotes are word for word.
- Biome has not been run on these files.

## How to reverse

Remove the button, the summary and link parts of the room page, the reader (`apps/server/src/rooms/reader.ts`) and the three Assistant tools. A later migration can drop `gist` and `item_link`; nothing else refers to them.

## Addendum, 2026-11-13: nothing covers anything

The founder's first real reading (DeepSeek, a room of four threads and two notes, eight suggested links) overlapped:
- the words of links sat on cards' titles and summaries, because they went at the middle of each line and the columns were 28px apart;
- key points ran past the right edge of their card (DeepSeek writes points of 40 to 80 characters, not "a few words");
- clusters placed before reading could grow into the ones below them once their summaries came in.

What changed:
- **Columns stand 128px apart** (rows 48px), so the words of a link (at most 116px wide, two lines) fit between two columns. Migration 021 moves the columns of rooms laid out before apart in proportion (from 24 + n × 292 to 24 + n × 392); their order and rows stay. A narrow window shows fewer columns.
- **A cluster that grows into the one below pushes it down**, 24px apart (`settleClusters`); so does a cluster dropped onto another. Clusters side by side are left alone.
- **The words of a link go where they cover nothing** (`placeLabels`): on the line, as near its middle as can be without covering a card or other words, else just beside the line; where nothing is clear, where the least is covered. Their sizes are measured once drawn.
- A link between two cards one above the other goes round the side with room (the right, unless the room is too narrow there).
- **Key points wrap** inside their card.
- **The right-click menu closes when you scroll** (the wheel or a finger), no longer on any scroll event: a scroll made just before a right-click could close the menu it opened.

- **With the Assistant open beside a room, the map stays in its own space** and scrolls sideways there. Its clusters and words are layered among themselves (`isolation: isolate`), and the Assistant sits above what is open beside it (z-index 9, under the selection buttons, menus and toasts). Before, cards and link words were drawn over the Assistant, and a map wider than the room ran under it. Arrange places the clusters again for the narrower width.

To reverse: set the gaps back in `RoomView.tsx`, drop the calls to `settleClusters` and `placeLabels`; migration 021 only moved positions, which Arrange places again.
