# Handoff 2026-11-13: a room's map without overlaps

## What happened

The founder pressed Read with AI in his room "Typescript" (four threads, two notes) with DeepSeek: six summaries and eight suggested links. He said "after ai read them, the ui overlaps". Seen in the browser pane on his Mac:
- the words of links sat on cards' titles and summaries;
- key points ran past the right edge of their cards (DeepSeek writes points of 40 to 80 characters);
- with columns 28px apart there was no room for words between cards.

A room built the same way with made-up text (`shot-dense.mjs` in the session scratchpad) showed the same: 12 labels on cards, 12 points past their card.

## What changed (ADR 0027 addendum)

- `packages/core/src/rooms.ts`:
  - `placeClusters` takes a `rowGap`;
  - `settleClusters` sets clusters that grew into each other apart (the lower one moves down);
  - `curveAt` and `placeLabels` put the words of each link on its line where they cover no card and no other words, else just beside it, else where the least is covered.
- `apps/web/src/RoomView.tsx`:
  - columns 128px apart, rows 48px;
  - clusters settled after each measure (not while dragging) and saved;
  - a link between cards one above the other goes round the side with room;
  - labels are measured once drawn and placed with `placeLabels`;
  - the canvas is no wider than the clusters plus its edges.
- `apps/web/src/styles.css`: key points wrap inside their card; link words at most 116px wide, two lines.
- `apps/server/src/store/migrations/021_room_spacing.sql`: rooms laid out before get their columns moved apart in proportion; rows and order stay.
- `apps/web/src/ContextMenu.tsx`: the menu closes on the wheel or a touch move, not on any scroll event. A scroll made just before a right-click (Playwright scrolling the card into view) closed the menu it had just opened; the rooms e2e failed 3 times in 4 because of it.
- `e2e/rooms.spec.ts`:
  - the read-with-AI test checks that no link words are on a card, no point is past its card, no clusters overlap;
  - the files test waits for the first thread to open before switching to Sources (a click right after load could be undone; it failed once in about 13 runs).

## Verified

- 320 unit and integration tests; tsc for core, server, web and the root.
- 76 e2e tests in the sandbox. The rooms spec passed 8 runs in a row after the fixes.
- Screenshots of the made-up room at 1440, 1280 and 1024 wide:
  - no labels on cards, no points out, no clusters overlapping, the page not wider than the window;
  - read live from the page, a cluster placed before reading is pushed down as the one above grows.

## Not verified

- His own rooms after the update, beyond what is checked in the browser pane at handoff time.
- Biome; Safari.

## Next

- A room of many links will still be busy; filters (only kept, one kind) remain an idea.
- At 1024px and narrower a room shows one column; if he works in a narrow window often, a narrower gap with labels beside the line may be better.
