# 0031. Sources from the web

Date: 2026-11-14. Status: accepted.

## Context

The founder asked that, during the asking process, Noema grab useful content from the internet and add it to the room as sources, besides the learner's own: "a room-oriented procedure". The design draft of 2026-11-14 proposed DeepSeek's own search API. It uses the same key he already has, at $0.75 per 1,000 successful searches; failed and empty ones are not billed. Brave dropped its free tier in February 2026, and Tavily would be a second account. He said "do whatever you think is the best".

## Decision

- **Search service.** DeepSeek's `POST /v1/tools/search` (`apps/server/src/web/search.ts`), with the model's key.
  - It is available only when the model in use is at `api.deepseek.com`, or the fake model in tests (a fake search).
  - Only the search words leave the computer.
  - Auth, quota and rate errors become the usual error kinds.
- **When it searches.** Only for a question asked in a thread that is in a room whose web is on (each room has a switch, on by default; `room.web`, migration 023).
  - A light model call first says whether the question needs the web, and with which words (`webPlanRequest`, `readWebPlan`). It is told to search for recent facts, papers, documentation and things to read further, not for what it can explain itself.
  - At most two searches; the best five pages by the service's relevance go with the question.
  - A search that fails is skipped, and the answer goes on.
- **Shown and sent.**
  - Each search is a step above the answer ("◎ Searched the web “…” · 3").
  - What was found goes before the question, each page labelled `[web n]` with its title, site, date, address and the service's account of it (`formatWeb`). The model is asked to cite what it uses and to say when a page does not settle the question.
  - What was sent shows the question "with what was found on the web".
- **Offered, never added on its own.** Under the answer, each page found is a card: where it is from, what it says, **Add to room**, Open, Leave it (`web_find`).
  - Add to room reads the page with Noema's own reader, as any web page added by address, and puts the source in the room. A page that cannot be read says so and stays offered.
  - Added twice, it is still one source.
- **For what is still open.** In a room's brief, **Find sources for these** searches once for each open question (up to four, three pages each, pages the notebook or the room already has left out). What it finds waits in Review, with the suggested links.
- Tests and CI use the fake search; the real service is never called from them.

## Consequences

- A question in a room with the web on costs one more light model call, and up to two searches when the model wants them ($0.0015 at most).
- The pages' text the model gets is the search service's summary, not the page; reading the page itself happens only when the learner adds it.
- With another provider than DeepSeek there is no web search; the switch is not shown.
- Not tried with the real service yet: how often the model searches, and how good the pages are.

## How to reverse

Turn the web off in a room, or remove the `searchWeb` call in `generation.ts` and the switch and cards in the web app. Migration 023's table and column can be dropped by a later migration; nothing else depends on them.
