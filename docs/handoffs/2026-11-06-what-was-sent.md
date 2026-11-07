# Handoff 2026-11-06: what was sent, and About you (M5, first part)

The founder agreed to M5 and asked which memory system to use. I recommended building our own small one on SQLite (statements about the learner that they write or accept, each linked to where it came from, plus "asked before" from search) over Mem0, Letta or Graphiti; that waits for his answer. This session built the part of M5 that memory will show up in. Decisions are in [ADR 0016](../adr/0016-what-was-sent.md).

## What changed

- **What was sent.** Under any answer, **What was sent** opens a dialog with exactly what the AI received for it, part by part: the instructions (folded), About you, what you are reading (the section of a source), the earlier turns (from the thread it came from, or this one), and your question with the passage it is about. Each part shows its size; the top line gives the model, the time, the estimate against the budget, and the provider's own count with what it read from its cache. If older messages were left out to fit, it says how many.
- **About you** in the header: a few lines (up to 4,000 characters) sent with every question in the notebook. The dialog above links to it, and says when nothing about you was sent.
- **Server.** Migration 012: `model_call.request`, the exact messages. `GET /api/messages/:id/context`. Answers from before show their manifest only, with a note.
- **Core.** `describeSent(manifest, request)`.

## Verified

| Check | Result |
| --- | --- |
| `node --test` | 184 pass. New: the parts of a request with About me (holding a heading of its own), a source, inherited turns, a merged thread and a passage, put back together exactly, their sizes adding up to the manifest's; a request with nothing but the question; older turns left out; **the M5 acceptance test**: the request kept for an answer is exactly what the model received, and its parts are named by the manifest; no context for a question or an unknown message; an older answer without the words |
| Playwright (sandbox, Chromium) | 49 pass, twice in a row. New, `e2e/context.spec.ts`: About you written in the header, then shown word for word in What was sent with the conversation and the question; from there, changing it; for a question about a source, the section of the text and the passage |
| Screens | What was sent for a question about a source, and About you |

## Not verified

- `pnpm lint` (Biome) and `pnpm e2e` on the Mac; tsc on the Mac is in the delivery below.

## Next

- The memory design, once the founder agrees: statements about him (written or accepted, linked to their exchange) shown in What was sent, and "asked before".
- The rest of M5: regenerate, Markdown and JSON export with import.
