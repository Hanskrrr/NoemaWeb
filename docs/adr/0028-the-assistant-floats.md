# 0028. The Assistant floats over what is open

Date: 2026-11-14. Status: accepted.

## Context

Since ADR 0024 the Assistant sat beside whatever was open, as a panel that took a strip of the window. On a room that strip squeezed the map: before the fix of 2026-11-13 the map's cards were drawn over the panel; after it, the map scrolled sideways behind it.

The founder then asked to "use floating window on other page, try to make the interface more like a super intelligent assistant". We read it as:
- the Assistant floats over whatever is open, instead of taking space from it;
- it is summoned anywhere and is aware of where you are;
- it is always at hand, without being in the way.

## Decision

- **Floating is the usual way.** ⌘J, the header button, the rail or the orb in the corner open the Assistant as a window floating over what is open. What is open keeps its full width.
  - It is held by its bottom-right corner, 24px from the edges at first, 460 × 620.
  - Drag its header to move it. Drag its top-left corner (or use the arrow keys there) to resize it; the bottom-right stays put, and it stops at the browser's edges and the header.
  - Where it is and its size are kept in this browser (`noema:assistant-float`) and brought back inside the window when the browser is made smaller (`clampFloat` in `apps/web/src/assistantFloat.ts`).
  - Esc in it puts it away (a quote preview open in it closes first).
- **Folded to a bar until something is asked.** The bar shows:
  - what was last asked, or what it is doing (thinking, looking things up, writing), one click from the conversation;
  - questions for the place (`asksFor`): a selection first, then the kind of thing open (a room, a source, a thread, a note), else the whole notebook;
  - the place, and an input that names it ("Ask about “Typescript”, or anything…").

  Asking opens it on the conversation. ⌄ folds it back. The fold is kept (`noema:assistant-folded`).
- **Its look.**
  - Glass over the page (a blurred, translucent background).
  - An edge that glows in the colours of what the Assistant is doing, brighter while it works: the same colours as the light around the window (ADR 0023).
  - A short rise as it opens (none with reduced motion).
- **Its orb rests in the corner when it is put away.** One click brings it back as it was.
- **Pinned beside** (⇥) is the panel of ADR 0024, unchanged: what is open makes room for it, its width is dragged at its left edge, and ⧉ floats it again. Its own page (⤢) is unchanged.
- The starter questions are only words to send; nothing is asked or done until the learner picks one. The Assistant still does nothing on its own (noticing things is a later step the founder decides).

## Consequences

- The floating window covers part of what is open. It can be moved, folded or put away; pinned, it covers nothing.
- The orb in the corner covers a 48px circle of what is open there.
- It sits above what is open (z-index 20) and below toasts, menus and dialogs.
- Tests: the geometry and the starter questions are unit tested (`apps/web/test/float.test.ts`). Two e2e tests cover floating: the bar, asking, folding, Esc and the orb; moving, resizing, keeping, pinning and floating back. The pinned tests pin first.
- Not tried in Safari; `backdrop-filter` needs its `-webkit-` form there, which is set.

## How to reverse

Set `noema:assistant-pinned` to `1` by default (or remove `FloatingAssistant` and the launcher from `App.tsx`): the panel of ADR 0024 is still there. `assistantFloat.ts`, the float styles and the fold in `Assistant.tsx` can then go.
