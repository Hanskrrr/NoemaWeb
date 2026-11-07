# Handoff 2026-11-06: one list at a time in the sidebar

The founder found that threads, sources and notes huddled together in the sidebar, and suggested switching between them with icons. Decisions are in [ADR 0014](../adr/0014-one-list-at-a-time.md).

## What changed

- **A rail of icons** on the left of the sidebar: Threads, Sources, Notes, and the Trash at the bottom. The panel beside it shows one list, with its name, a count and its action (+ New thread, + Add source, + New note).
- **It follows what is open.** A note shows Notes; a thread asked about a source (or a side question of one) shows Sources; any other thread shows Threads. It changes only when you open something, not while you look at another list.
- **More room to read.** Click the icon of the list already shown to hide the panel, leaving only the rail; click any icon to bring it back. Both choices are remembered in this browser.
- **Badges.** The Trash icon shows how many things are in it (it no longer appears and disappears at the bottom of the list); the Notes icon shows a dot while a note is being written.
- **Empty lists** say what goes in them ("Nothing to read yet. Add a web page or an arXiv paper, or paste text…").

## Verified

| Check | Result |
| --- | --- |
| Playwright (sandbox, Chromium) | 44 pass, twice in a row. New, `e2e/sidebar.spec.ts`: one list at a time; a new note shows Notes; a search hit in a plain thread shows Threads with the thread marked; hiding the panel, kept after a reload; the Trash count on its icon. Tests that used the stacked lists now pick the list first |
| `node --test` | 178 pass (no server change) |
| `tsc` on core, server, web and root (founder's Mac) | Clean |
| Screens | Each list, the panel hidden beside a source, and dark mode |

## Not verified

- `pnpm lint` (Biome) and `pnpm e2e` on the Mac.
- On a narrow window the sidebar still slides in from ☰, now with the rail; not tried on a phone (outside the scope fence).

## Next

- Unchanged: a real arXiv paper (see the sources handoff), two weeks of real use, then M5.
