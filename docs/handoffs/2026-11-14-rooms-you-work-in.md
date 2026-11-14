# Handoff 2026-11-14: rooms you work in

The founder read the design draft (project doc `NOEMAWEB_ROOMS_WORKPLACE_DRAFT.md`) and said "do whatever you think is the best". He added:
- more colours;
- drag to connect, with the AI choosing the right line, and hold a second to move;
- the Assistant renames, deletes and merges rooms, with all permissions.

The work goes in rounds; this file grows with each.

## Round 1 (ADR 0029): drawing links, colours, review, the Assistant's room powers

- **Room page** (`RoomView.tsx`):
  - press and move from a card to draw a link (`connect`), or hold 0.7 s to lift the cluster and move it;
  - the AI chooses the drawn link's kind (`api.chooseLink`), the line glowing meanwhile;
  - suggested links in `ReviewLinks`, not on the map;
  - kept links coloured by kind, a dot at rest, words for the card in focus; a legend;
  - Merge into…; Read with AI and Review as orb buttons.
- **Core** (`gists.ts`): `CHOOSE_PROMPT`, `chooseLinkRequest`, `readChosenLink`. **Assistant tools** (`assistant.ts`): `rename_room`, `delete_room`, `merge_rooms`, `change_link`, `unlink`.
- **Server.**
  - `RoomReader.chooseKind`; routes `GET /api/links/:id`, `POST /api/links/:id/choose`, `POST /api/rooms/:id/merge`.
  - Repo: `roomSnapshot`, `restoreRoom`, `mergeRooms`, `itemLinkRow`, `putItemLinkRow`; `updateItemLink` takes `why`.
  - Changed by hand, a drawn link loses the AI's reason.
  - Fake model: purpose `link-kind` (`[[flip-link]]`, `[[fail-link-kind]]`).
- **Styles:** colours per kind of thing and of link, light and dark; `.ai-button`; the review panel.
- **Verified:** 328 unit tests; 80 e2e. New tests:
  - drag to connect;
  - hold to move;
  - Review;
  - the AI's choice (also turned around, and without a model);
  - the Assistant's room powers with Undo;
  - merge by hand.

  Screenshots in dark, at 1440: at rest, in focus, Review.

## Round 2 (ADR 0030): the room's brief, reading you can see, making things in the room

- **Core.**
  - `briefRequest` / `readBrief` (`gists.ts`).
  - `RoomContext`, `formatRoom`, the `room` part in `assembleContext` and `describeSent` (`context.ts`).
  - `RoomReading` gets the `brief` phase and `current`; `RoomView.brief`.
- **Server.**
  - Migration 022 `room_brief`.
  - Repo: `roomBriefBasis` (a hash of each thing as it is now), `saveRoomBrief`, `roomOfThread`; the room snapshot keeps the brief.
  - The reader writes the brief after the links and says which things it is summarizing; `generation.ts` passes the room to `assembleContext`.
  - Fake model: purpose `brief` (`[[fail-brief]]`).
- **Web.**
  - `RoomBrief` (the brief, still open, Review, Read) and `CreateHere` (Ask, Note here, Source here) in `RoomView.tsx`; cards glow while read.
  - `RoomTrail` (`Rooms.tsx`) above a thread, source or note.
  - `App.tsx`: a source added from a room goes in it.
  - What was sent: "The room it is in".
- **Verified.**
  - 331 unit tests. New: the room part sent and split back; the brief read; the brief written, older when a thing changes, and sent with a thread's next question.
  - 81 e2e. New: a room you work in (brief, still open, ask here and What was sent, note here, source here, older).
  - Screenshots of the brief in dark.

## Round 3 (ADR 0031): sources from the web

- **Core** (`web.ts`): `webPlanRequest`, `readWebPlan`, `formatWeb`. Context: a `web` part before the question (`withWeb` in What was sent). `WebFind`; `Message.web`; `Room.web`; `RoomView.webFinds` / `webAvailable`. Lookup steps get `web`.
- **Server.**
  - `web/search.ts`: `DeepSeekSearch` and `FakeSearch`; `ModelSettings.search()` (DeepSeek or the fake model only).
  - Migration 023: `web_find`, `room.web`.
  - `generation.ts` `searchWeb` for threads in a room with the web on.
  - Routes: `PUT /api/rooms/:id/web`, `POST /api/rooms/:id/find-sources`, `POST /api/web/:id/add`, `POST /api/web/:id/dismiss`.
  - Fake model: purpose `web-plan`, searching only for `[[web]]` / `[[web2]]`.
- **Web.**
  - `WebFinds` cards under answers and in a room's Review.
  - "◎ Web on/off" in the room's create bar; Find sources for these in the brief.
- **Verified.**
  - 338 unit tests. New:
    - the plan read;
    - the web part sent and split back;
    - DeepSeek's request and reply read with a stand-in fetch;
    - which providers can search;
    - a room thread searching (and not, with the web off);
    - finding sources for what is open;
    - Add to room reading a real local page.
  - 82 e2e (one new). One full run had `branch.spec` "a double-clicked word" fail once; it passed alone three times and in every other run.
