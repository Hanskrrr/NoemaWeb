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
