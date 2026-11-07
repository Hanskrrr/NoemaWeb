# 0014. The sidebar shows one list at a time, picked on a rail of icons

Date: 2026-11-06. Status: accepted.

## Context

With sources (ADR 0013), the sidebar stacked four lists: threads, sources, notes and the Trash. The founder found they huddled together: a long list of threads pushed sources and notes out of sight, and each list's heading was easy to miss.

## Decision

- A narrow **rail** on the left has one icon per list, each with a short label: Threads, Sources, Notes, and the Trash at the bottom. The panel beside it shows **one list at a time**, with its name, a count and its action (+ New thread, + Add source, + New note).
- The panel **follows what is open**: opening a note (from search, a citation or a link) shows Notes; a thread asked about a source, or one of its side questions, shows Sources; any other thread, Threads. It changes only when what is open changes, never while the learner is looking at another list.
- Clicking the icon of the list already shown **hides the panel**, leaving the rail, for more room beside a source; clicking any icon shows it again. The list shown and whether the panel is hidden are remembered in this browser.
- The Trash's icon shows how many things are in it; the Notes icon shows a dot while a note is being written.

## Consequences

- Fewer things are visible at once: to see notes while a thread is open, click Notes. Search (⌘K) still finds everything.
- The test ids `trash-toggle` and the stacked sections are gone; tests show a list with `showList()` first.

## How to reverse

Render all four panels one after another again in `Sidebar.tsx` and drop the rail; the lists themselves did not change.
