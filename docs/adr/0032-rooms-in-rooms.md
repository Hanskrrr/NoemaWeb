# 0032. Rooms in rooms

Date: 2026-11-14. Status: accepted.

## Context

The founder asked what happens when a room is, by its meaning, inside another room: a small field included in a bigger one. The design draft of 2026-11-14 proposed that a room can be put in other rooms as a door: many homes, no copies, never inside itself, and what is in it not spilled. He said "do whatever you think is the best".

## Decision

- **A room can be put in other rooms** (`room_door`, migration 024): one room, many homes, no copies.
  - Never inside itself, at any depth. `wouldLoop` checks this before a room is put in, and it is refused in words: "“Typescript” is inside “Computing”, so “Computing” cannot go in it."
  - A room's `parents` and `rooms` are part of it, and so is a count of the rooms in it.
- **Inside the bigger room it is a door**, placed on the map like a cluster (its place is kept on the door). What is in it is not spilled into the bigger room.
  - The door shows its name and what it holds: a picture with a tile for each thing in its kind's colour, the counts, and its brief if it was read (otherwise a few of its things). It also says where else the room is.
  - It looks like a stack in the rooms' colour.
  - A click opens it. Dragging it moves it at once, since it has no links. A card drawn onto it goes in that room; the card stays here too, with "Take it out of “…”" offered.
- **The way in.** A room opened through a door shows the rooms passed through above its name, each one click back. Opened another way, it shows the rooms it is in.
- **The sidebar is a tree.** Each room shows under each room it is in, marked ⧉ with "also in" when it has other homes. Rooms with rooms in them fold.
  - Dragging a room onto another puts it inside.
  - Right-click lists the bigger rooms it can go in (none that would put it inside itself), or makes a new room around it.
  - Dragged onto an open room's map, it goes in as a door where it was let go.
- **Room here**, in the bar at the foot of a room: the rooms that can go in it, or a new room inside it.
- **The bigger room's brief is written from its rooms' briefs.** Each room inside is one more numbered thing (`room “…”`) with its brief, or "not read yet" and what it holds. Rooms inside are not read again.
  - The brief is older when one of them is read again (its basis has each inner brief's time).
  - A room with no rooms in it hashes as before, so briefs already written stay fresh.
  - An open question can be tied to a room inside, and opens it.
- **A thread in a room is told the bigger rooms** its room is part of, by name, in the room part of the system message.
- **Taken down, merged, undone.**
  - Deleting a room takes its doors; the rooms in it stay rooms.
  - Merging one room into another moves its rooms and its homes to the other, skipping any that would put a room inside itself.
  - The Assistant's Undo of a delete or merge brings the doors back. Snapshots now keep doors both ways, and a room restored is upserted rather than replaced, so nothing hanging on it is lost.
- **The Assistant** can put a room in another (`put_room_in`; either may be a new name, to make it) and take it out (`take_room_out`), each waiting for Do it, with Undo.
  - Listing rooms says where each is and what rooms are in it.
  - Deleting a room with rooms in it says they stay.

## Consequences

- Reading a bigger room costs nothing more: its brief call is the same one call, with a line for each room in it. Its brief is only as good as the briefs of its rooms, so the brief panel suggests reading those first.
- What a room "holds" is still only what was put in it. A thread in a room inside is not in the bigger room for search, the web switch or the room part sent with questions; only the bigger room's name is sent.
- A room in two rooms shows twice in the sidebar, once under each.
- The map by meaning (lanes) is the next step; doors are placed like clusters until then.

## How to reverse

Drop the `room_door` table in a later migration. Then remove the doors from `roomView`, the tree in `Rooms.tsx`, the door cards, Room here and the path in `RoomView.tsx`, and the two Assistant actions. Nothing else depends on doors.
