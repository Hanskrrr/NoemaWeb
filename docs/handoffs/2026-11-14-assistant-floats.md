# Handoff 2026-11-14: the Assistant floats

## What happened

The founder opened the Assistant on a room and it overlapped (fixed on 2026-11-13: the map now scrolls in its own space). He then asked to "use floating window on other page, try to make the interface more like a super intelligent assistant". Decisions in [ADR 0028](../adr/0028-the-assistant-floats.md); the fence note is in AGENTS.md.

## What changed

- **Floating is the usual way** (`App.tsx`, `FloatingAssistant`).
  - ⌘J, the header button, the rail or the orb in the corner open it over what is open; what is open keeps its width.
  - Moved by its header; resized from its top-left corner (arrow keys too); kept in this browser and brought back in reach when the browser shrinks.
  - Esc puts it away.
- **Folded to a bar** (`Assistant.tsx`) until something is asked:
  - what was last asked, or what it is doing;
  - questions for the place (`asksFor`);
  - an input that names the place.

  Asking opens the conversation; ⌄ folds it.
- **Glass with a glowing edge** in the Assistant's colours, brighter while it works; a short rise as it opens (none with reduced motion) (`styles.css`).
- **The orb rests in the corner** when it is put away (`assistant-launcher`).
- **Pinned beside** (⇥) is the old panel; ⧉ floats it again. Its own page (⤢) is unchanged.
- **Keys:** `noema:assistant-pinned`, `noema:assistant-folded`, `noema:assistant-float`. `noema:assistant-dock` still says whether it is open. Someone who had the panel open sees it float.
- **Geometry and questions** in `apps/web/src/assistantFloat.ts`, with `apps/web/test/float.test.ts`.
- **Also:** the room canvas added its left margin twice (24px too wide; it could show a needless sideways scrollbar); fixed.

## Verified

- 324 unit and integration tests; tsc for core, server, web and the root.
- 79 e2e tests in the sandbox:
  - two new ones for floating (the bar, its questions and placeholder, asking, folding, Esc and the orb; moving, resizing, kept after a reload, pinning and floating back);
  - the pinned panel test and the rooms test pin first;
  - the rooms test also checks that, floating, the room keeps its width and nothing of it shows through the Assistant.
- Screenshots of a made-up room in dark (1440×900) and light (1280×800): closed with the orb, the bar, asking, the answer, folded.

## Not verified

- On his Mac beyond the browser pane check at handoff.
- With DeepSeek: the starter questions are only words; how well it answers "What does this room add up to?" is to be seen.
- Safari (`-webkit-backdrop-filter` is set); Biome.

## Next

- If he likes it: the starter questions could be learnt from what he asks most in each kind of place, and "noticing on its own" (ADR 0023's later step) is his call.
- Remember the bar's last position per page kind? Only if he asks.
