# Handoff 2026-11-13: the Assistant, and a frame that shows it working

The founder read about DeepSeek's Super-agent prototype and wants "a uni super intelligent agent to manage the whole vault, like a consistent assistant". The plan has four steps (ADR 0023): the Assistant reads the notebook and answers; memory items it proposes and you keep; background jobs whose results are suggestions; noticing things on its own, in observe mode first. He said go ahead, and asked for "some fancy animation … the full screen effect on the frame of the web, like users are really talking to a living assistant". This session built step 1 and the frame. Decisions are in [ADR 0023](../adr/0023-the-assistant.md).

## What changed

- **The Assistant.**
  - It sits at the top of the sidebar, with its orb, at `#/assistant`. It is one thread per notebook, of its own kind (migration 016). It is not listed with the threads, never retitled, and never offered as "asked before".
  - Before the first question it shows a hello with four ways to start.
- **It looks before it answers.**
  - Each question goes with a short labelled overview of the notebook: sources, notes, the latest threads, and side questions not come back from.
  - The model has three read-only tools: `search` (Noema's search, all words first, then any of them), `open` (a thread's exchanges, a source's outline, a section or a page, a note's blocks) and `list`.
  - It answers in rounds, at most six, with four lookups a round. Each round is its own model call. The last one holds everything for What was sent.
  - DeepSeek's reasoning before a lookup is sent back in the next round, as DeepSeek requires with tools. If a request with tools is refused while thinking, the round is asked again without thinking. If tools are refused altogether, it answers from the overview.
- **Labels and citations.**
  - Everything it is shown carries a label, `[3]`, numbered through the answer.
  - The labels it cites are kept with the answer (`message_revision.lookups`). They become buttons that open the exact message, passage (in its version) or note. A number it was never given stays text.
  - Earlier answers go back to the model without their labels.
- **While it works.**
  - The stream reports what it is doing (`phase`) and each lookup (`step`).
  - The answer shows a trail of what it looked up, and "Looking through your notebook…" while it looks.
  - What was sent lists each lookup with what came back, and its reasoning folded away.
- **The living frame.**
  - A light runs around the edge of the window while the Assistant is open. It is blue and breathing while it waits, brighter while you type (each key stirs it), and a violet flowing ring while it thinks.
  - While it looks things up it is a quick teal sweep, held for 1.1 s per lookup so it can be seen. While it writes it is warm and pulses with the words. When it is done it blooms in green, then goes back to waiting.
  - It goes out when you leave the Assistant.
  - It is drawn with CSS: a masked ring and a blurred copy for the glow. The colours are registered properties, so they fade. The light turns with the Web Animations API, so its speed changes without a jump. It is one fixed layer that takes no clicks.
  - With reduced motion asked for, nothing turns and the glow does not breathe.
- **The scope fence** in AGENTS.md notes both exceptions (animation, and lookups across the notebook) as the founder's decision.

## Verified

| Check | Result |
| --- | --- |
| `node --test`, sandbox | 274 pass. New, core: tools, labels (normalised only when every number was given; intervals, code and math left alone), labels taken out of earlier answers, the overview after the history, lookups in What was sent. Provider: tools and `tool_choice` sent; reasoning and tool calls put together from streamed pieces; tool turns and reasoning back on the wire (reasoning to DeepSeek only). Server: one Assistant per notebook; rounds, phases and steps; citations pointing at the source; What was sent; at most four lookups a round and six rounds; unknown labels and bad arguments told back; its own thread not searched; not "asked before"; refusals while thinking and of tools; a side question from an Assistant answer. Web: route, presence, part labels |
| Playwright, sandbox | 66 pass (twice; the first run had one failure in `sources.spec.ts` that passed alone and on the second full run: `showList` reads the rail before the app has opened the latest thread, an old race). New: ask, the trail, a citation that opens the source, What was sent; the frame through listening, thinking, looking, writing, done and idle; no turning with reduced motion; not in the thread list |
| tsc | Core, server, web and the root project clean in the sandbox |
| By eye | Screenshots in light and dark of the hello, listening, thinking, looking, writing, done, the answer and What was sent; a 22-second recording in dark mode |

## Not verified

- **DeepSeek.** All of this ran with the fake model. Not seen yet: whether `deepseek-flash` looks things up before answering, whether it cites labels as asked, and whether thinking with tools works as DeepSeek's guide says (reasoning sent back within an answer, earlier answers as text only). The fallbacks are there if it refuses. The log line `assistant looked up` counts lookups per answer, and `model refused lookups…` says when a fallback was used.
- **Biome.** Not run here. Watch for its view of the `biome-ignore` comments and of `LivingFrame.tsx`.
- **His Chrome and his screen.** The frame was seen in headless Chromium at 1280×800. Blur over a whole Retina window costs GPU time; watch whether it stutters while an answer streams.
- **Cost.** Each question carries the overview and every lookup's result, uncached, in up to six calls. The usage of every call is recorded; look at a few in What was sent after real use.

## What's next

1. On the Mac: pull, restart `pnpm dev`, open the Assistant (top of the sidebar). Ask something whose answer is in the notebook ("What have I asked about pipeline parallelism?") and something from a deck ("What does Week 4 say about all-reduce?"). Check the citations open the right places, and tell me how the frame feels (too much, too little, too slow).
2. Then decide step 2 (memory items) against M6. I would wait for a week of real use first.
3. Still open from before: pushing (with the lockfile), `pnpm asked:check`, trying PDF pages with DeepSeek.
