# 0023. The Assistant: one assistant for the whole notebook, and a frame that shows it working

Date: 2026-11-12. Status: accepted (step 1 of 4).

## Context

Every thread in Noema is its own conversation: the model sees that thread, its passage and pins, and nothing else. The founder wants one assistant for the whole notebook, "a consistent assistant" that can answer from everything he has read, asked and written. The idea came from DeepSeek's Super-agent prototype (`deepseek-ai/dsh-superagent-prototype`, October 2026): one long-lived router that sees everything and speaks for the system, workers that do slow jobs in their own sessions, tickets kept in SQLite, and work it starts by itself kept in an *observe* mode until people trust it. Its principle is to take as little attention as possible and give as much value as possible.

Most of that maps onto what Noema already has: the server makes every model call and keeps long runs in SQLite (M1), search (M4), What was sent (M5). What does not carry over is a mode that changes things by itself: in Noema the learner's writing is never changed by a model process (PARADIGM §5), and suggestions are reviewed.

He also asked for the assistant to feel alive: a glowing frame around the whole window while it listens, thinks, looks things up and speaks.

The plan has four steps: (1) the Assistant reads the notebook and answers, with citations; (2) memory items it proposes and you keep; (3) background jobs and suggestions you accept; (4) noticing things on its own, in observe mode first. This record is step 1. The founder said to go ahead.

## Decision

- **One Assistant per notebook**, a thread of its own kind (`thread.kind = 'assistant'`, migration 016), reached from the top of the sidebar (`#/assistant`). It is a thread like any other in what it keeps (questions, answers, Ask again, What was sent, side questions from an answer), but it is not listed with the threads, never retitled, never offered as "asked before".
- **It looks things up instead of being sent everything.** The provider gains OpenAI-style tool calls. The Assistant has three, all read-only:
  - `search(query)`: Noema's own search over threads, answers, notes and sources (all the words first; if that finds little, any of them);
  - `open(ref, page?)`: what a label points at: a thread's exchanges, a source's text (a section, or one page of a PDF), a note;
  - `list(what)`: every thread, source or note, newest first.
- **Labels, not ids.** Every item the Assistant is shown has a short label, `[1]`, `[2]`…, numbered through the answer. It opens things by label and cites by label. With each question it gets a short overview of the notebook (sources, notes, recent threads, side questions not come back from), labelled the same way; the overview goes with the question, not the instructions, so the cached prefix stays the same.
- **Citations open the exact place.** When the answer is finished, the labels it cites are kept with the revision (`message_revision.lookups`, with the steps it took): a label becomes a button that opens the message in its thread, the passage in its source, or the note. A label it did not get from a lookup stays plain text.
- **Bounded.** At most six rounds of looking up and four lookups a round, each result cut to a few thousand characters; then it must answer with what it has. Each round is a model call of its own; What was sent shows the last, which holds every lookup and what came back.
- **DeepSeek's thinking.** With tools, DeepSeek requires the reasoning of a round that called a tool to be sent back in the next round; Noema does that within an answer, and sends earlier answers as their text only. If the provider refuses a request with tools while thinking, the round is asked again without thinking; if it refuses tools, the Assistant answers from the overview alone, and says so in the log.
- **What the reader sees while it works.** The answer streams as any answer does, and the stream also says what it is doing (`phase`: thinking, looking, writing) and each lookup as it happens ("Searched “variance”", "Opened “Week 4”"). The steps stay under the answer afterwards.
- **The living frame.** While the Assistant is open, a soft light runs around the edge of the window: breathing while it waits for a question, a slow flowing ring while it thinks, a brighter sweep while it looks things up, a glow that pulses with the words as it writes, and a short bloom when it is done. A small orb beside its name does the same. It is drawn with CSS on one fixed layer that takes no clicks. With reduced motion asked for by the system, the frame does not move: it only fades between states.
- **Text it reads is material, not instructions.** Everything a lookup returns is labelled as the learner's material, and the Assistant has no tool that changes anything, so a page that tells it to do something can at most make it say something.

The scope fence lists "animation" and rules out semantic features; this is the founder's decision for the Assistant (as for ADR 0020).

## Consequences

- A question to the Assistant costs more than one in a thread: the overview (up to about 1,500 tokens) and every lookup's result, uncached, and up to six calls. The usage of each call is recorded as before.
- It finds what search finds: words, not meaning (no embeddings). The model can search again with other words, and does.
- It can be wrong about the notebook; its citations are how to check it.
- Steps 2–4 (memory items, background jobs with suggestions, noticing on its own) are not built; ideas.md has them.

## How to reverse

Remove the sidebar entry and the route; the Assistant's thread stays in the store and can be opened as a plain thread. Tools are only sent for the Assistant, so other answers do not change.
