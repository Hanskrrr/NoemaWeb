# 0030. A room to work in: its brief, reading you can see, making things in it

Date: 2026-11-14. Status: accepted.

## Context

Step 1 of the design draft of 2026-11-14 (ADR 0029 has the first part). The founder wanted:
- a room-oriented way of working: start a thread or add a note in the room;
- the AI's reading of a room to be something you feel, not plain text.

## Decision

- **The room's brief.** After the summaries and the links, reading a room writes one more thing (`briefRequest`, `readBrief`, migration 022 `room_brief`):
  - what the room adds up to, in three or four sentences, in the order a learner would follow it;
  - up to four questions still open in it, each tied to the thing it is open in.

  The model reads the numbered summaries; it is told never to invent.
- **Freshness.** The brief keeps a hash of what each thing in the room was when it was written. A thing changed, added or taken out shows it as older ("things changed since") until the room is read again.
- **The brief is the first thing in a room**, in the AI's colours:
  - what it adds up to;
  - still open, each opening the thing it is open in;
  - to review: the suggested links, behind Review;
  - Read with AI / Read again.

  Before a room is read, it invites reading and says what it costs ("about n calls").
- **Reading you can see.**
  - The server says which things are being summarized this moment (`RoomReading.current`), and their cards glow while they are read (still with reduced motion).
  - A bar fills as it goes; the phases read "Summarizing 2 of 6…", "Looking for links…", "Writing the brief…".
- **Making things in the room.** A bar at the foot of every room:
  - **Ask** starts a thread with the question. The thread is put in the room before the question is sent, so its first answer already knows the room.
  - **Note here** makes a note in the room and opens it.
  - **Source here** opens Add a source; what is added goes in the room, and the room stays open.
- **A thread in a room is answered with the room.** Its questions carry the room's name, its brief and what is still open, as one part of the system message, after the pinned passages (`formatRoom`, `RoomContext`).
  - It changes only when the room is read again, so the prompt cache holds.
  - The rooms holding the thread (or the thread a side question is part of) are looked at; the one whose brief was written last is used. A room with no brief adds nothing.
  - What was sent shows it as "The room it is in", word for word.
- **Where a thing lives.** A thread, source or note shows the rooms it is in above it, one click back to each.

## Consequences

- Reading a room costs one more model call (the brief).
- Every thread in a room with a brief now gets the brief with its questions, up to about 3,000 characters more each time (most of it cached). It is in What was sent; taking the thread out of the room stops it.
- "Still open" is the model's reading of the summaries; it can miss something or name something that was answered later. The brief says when it is older, and reading again rewrites it.
- Not tried with DeepSeek yet.

## How to reverse

Remove the brief call from `RoomReader.run`, the brief panel and the create bar in `RoomView.tsx`, and the `room` part in `assembleContext` (or stop passing it in `generation.ts`). Migration 022's table can be dropped by a later migration.
