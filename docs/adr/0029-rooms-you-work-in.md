# 0029. Rooms you work in: drawing links, colours, review, the Assistant's room powers

Date: 2026-11-14. Status: accepted.

## Context

After reading a room with DeepSeek, the founder found the map messy: every link was drawn at once, with its words, and suggested links were dashed lines among the kept ones. He also asked how this differs from Obsidian's graph, and wanted the AI's features to be felt rather than shown as plain text.

The design draft of 2026-11-14 (project doc `NOEMAWEB_ROOMS_WORKPLACE_DRAFT.md`) proposed four steps. He answered "do whatever you think is the best", and added:
- more colours, to tell things apart;
- users connect two cards with the mouse and the AI helps build the right lines, so dragging connects and holding a card for a second moves it;
- the Assistant can rename, delete and merge rooms, "give it all permissions".

This is the first step. Its links are suggested by the AI and kept by the learner, like ADR 0027; the fence note in AGENTS.md covers it.

## Decision

- **Dragging from a card to another links them.**
  - Press a card and move at once: a line follows the pointer, and the card under it is marked. Let go on it and the link is made, as yours.
  - The AI then reads both ends (their summaries, or the first 1,500 characters of their text) and chooses what the line means, read from the first card to the second (`POST /api/links/:id/choose`, `chooseLinkRequest` / `readChosenLink`).
    - It may turn the line around if it reads better the other way.
    - It gives one sentence of why.
    - While it chooses, the line glows in the Assistant's colours.
  - The editor opens on the line and says "Drawn by you; the AI chose what it means: …". Changing its kind, words or direction by hand removes the AI's reason.
  - Without a model, or when the model fails, the line stays as drawn ("is related to"), and the room says so in words.
  - Drawing a second line between the same two shows the link they have.
  - "Link to…" on right-click still works, for the keyboard, and goes the same way.
- **Holding a card still for 0.7 s lifts its cluster** (a ring fills while held), and then it moves with the pointer. A press let go without moving is a click and opens the card. Alt+arrows still move a cluster.
- **Suggestions wait in Review, not on the map.**
  - The AI's suggested links are listed behind a **Review n** button: "A explains B", with the AI's reason.
  - Each can be kept, have its kind changed (which keeps it), be turned around or be dismissed; Keep all keeps every one.
  - Only kept links are drawn.
- **Kept links are calm.**
  - Each is a line in its kind's colour, with an arrow; at rest its middle is a dot in that colour.
  - Pointing at a card shows the words of its links and fades the others.
  - A legend above the map shows the kinds the room uses, with how to draw and move.
- **Colours.**
  - Kinds of thing: thread blue, source amber, note green; rooms (later) violet.
  - Kinds of link: explains teal, example of green, builds on blue, contrasts with orange, asks the same as pink, part of violet, related grey.
  - Each has a light and a dark value. A card's left edge and kind label wear its kind's colour, stronger the more it was asked about.
- **What the AI does on your word wears its colours.** Read with AI, Read again and Review are buttons with the orb. Read with AI is a gradient while there is something new to read or it is reading.
- **The Assistant can do all of it with rooms and links.** New tools:
  - `rename_room`, `delete_room`, `merge_rooms`;
  - `change_link` (keep, dismiss, change kind or words, turn around);
  - `unlink`;

  besides `put_in_room`, `take_out_of_room` and `link`. Each still waits for Do it and can be undone. Undo puts a deleted or merged room back as it was (all its rows), a renamed room's name, and a link's row.
- **Merge into…** in a room's header merges it into another room by hand (`POST /api/rooms/:id/merge`): what was put in it is put in the other, and it goes.

## Consequences

- Drawing a link costs one model call; a room is not read for it.
- Dragging no longer moves a cluster at once. Moving takes a moment's hold; that is the trade for drawing links with the mouse.
- With suggestions off the map, a room shows only what the learner kept. The AI's ideas are one click away and no longer clutter it.
- "All permissions" was read as all the room and link powers. The Assistant still proposes and the learner confirms. Acting without asking is not built; if the founder meant that, it is his decision and a separate change.
- Not tried with DeepSeek: how well it chooses kinds for real lines.

## How to reverse

Remove the gesture in `RoomView.tsx` (back to drag-to-move) and the choose route, and draw suggested links on the map again. The new Assistant tools can be removed from `ActionArgs` and the tool list; nothing stored depends on them.
