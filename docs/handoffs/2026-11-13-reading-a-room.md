# Handoff 2026-11-13 (night): reading a room

The founder found the version rough. He also said the Assistant could not help with rooms, and that the things in a room did not look related. He proposed that the AI process a room's materials: a brief summary of each, links back to the original, and relationships between them that he can edit himself.

We agreed it was rough, for three reasons:
- a card showed only a title and counts;
- lines came only from links that happened by the way, so most rooms had none;
- the Assistant was not told which room was open.

His idea fixes the first two. Decisions are in [ADR 0027](../adr/0027-reading-a-room.md); the fence note is in AGENTS.md.

## What changed

- **Read with AI**, at the top of a room. The button says how many things need a summary ("Read with AI · 3 new"); after that it is **Read again**. It runs only when pressed.
- **A summary on every card:** one or two sentences, and up to three key points.
  - Each point is a small link (↗) to the exact words it came from: the source at that place, the thread at that message, the note at that block. The words are marked on arrival.
  - A point whose words the AI did not copy exactly is shown without a link.
  - A summary written before the thing changed says "older".
- **Suggested links.** Then the AI suggests links between the things: explains, is an example of, builds on, contrasts with, asks the same as, is part of. Each comes with a reason. They are dashed lines with a question mark until you keep them.
- **Editing a link.** Click its words to:
  - **Keep** it;
  - change its kind or put your own words;
  - **Turn around**;
  - **Dismiss** it (it will not be suggested again) or **Delete** a kept one.

  **Link to…** on right-click draws one by hand: pick the other card, then the kind.
- **Pointing at a card** brings its links forward and fades the others.
- **The Assistant knows the room it is asked in.** It gets the room's things with their summaries and the links between them. It can propose **link** and **take out of a room**, as well as **put in a room**; all wait for Do it, with Undo. The line above its box shows the room.
- **Code.**
  - New: core `gists.ts`, `links.ts`; server `rooms/reader.ts`; migration 020 (`gist`, `item_link`).
  - Routes `POST /api/rooms/:id/read`, `POST /api/notebooks/:id/links`, `PATCH|DELETE /api/links/:id`; the room's GET carries summaries, links, how many are unread and the reading's progress.
  - The fake model writes predictable summaries and links.

## Verified

| Check | Result |
| --- | --- |
| `node --test`, sandbox | 316 pass. New, core: the request (cut when long); quotes found and turned into the right place in a source, a thread and a note, and a quote not found linking nowhere; links read from the reply (numbers in the list, known kinds, each pair once). Server: reading a room (summaries, then suggested links with reasons); read again only what changed; a summary of a changed thread shown as older; keep, change, turn around, dismiss (never suggested again), delete, draw by hand (not twice between the same two, not to itself); failing in words without a model and when the model fails; export holds them; the Assistant given the room with its summaries and links, linking two things and taking one out, each with Undo; an older database upgrading in place |
| Playwright, sandbox | 76 pass (1 new): Read with AI, a point opening the source with its words marked, the suggested link kept, its kind and words changed, deleted, a link drawn with Link to… |
| tsc | Core, server, web and the root project clean |
| By eye | Screenshots of a read room with summaries, points and links, and a link's editor |

## Not verified

- **DeepSeek.** Everything ran on the fake model, so its summaries read "Fake summary of…" and its links simply chain the things. With DeepSeek, unknown: how good the summaries are, how often quotes are word for word (the points that link), and how many links it suggests and whether they are worth keeping.
- **A big room.** Dozens of things and links: the map will be busy; fading helps only when pointing at a card.
- **Biome.** Not run here.

## What's next

1. On the Mac: pull (migration 020 on start), open a room, press Read with AI. Keep or dismiss what it suggests, and tell me what was wrong.
2. Then: a summary of the whole room (what is settled, what is still open), filters for links, and "met before" links to new sources.
3. Still open: About you, pushing (with the lockfile), `pnpm asked:check`.
