# 0020. Asked before: a reminder before a new thread, side question or note

Date: 2026-11-11. Status: accepted; amended the same day (the model reads for meaning).

## Context

The founder's principle: do not add threads or notes that are not needed. If something was asked before and the learner starts a new thread to ask it again, Noema should say it is already somewhere, so the notebook does not fill with repeats. The brief has this as insight I2, "You've asked this before".

Two questions decide whether it helps or nags: how a repeat is recognised, and what the reminder may do.

The first version compared words only. The founder's judgement on seeing it: comparing words instead of meaning is of little use. He chose to let the chat model judge (over embeddings on the Mac: a download of 100 MB or more, a heavy dependency, and weaker on pairs that need subject knowledge). The scope fence rules out embeddings and semantic search for v0.1; this use of the chat model is his decision.

## Decision

- **Two checks.** Words are compared at once (below). When typing has paused for a second, **the learner's chat model reads for meaning** (`apps/server/src/chat/asked.ts`, `POST /api/notebooks/:id/asked/meaning`): it gets the notebook's earlier questions as a numbered list, each with its passage, the one-line summary of its answer and its thread, then the new question, and replies with one line of JSON, `{"same": […], "related": […]}`. `same`: the earlier answer would answer the new question too, in whatever words or language; `related`: the same specific subject. It is told that most questions are new and to list nothing when unsure.
  - The list comes first and only grows at its end, so the provider's prompt cache holds between checks. At most the newest 300 questions are read; the reply is at most 80 tokens.
  - No call when nothing is typed, when no model is connected, or when the words already say it is the same question. The last 50 verdicts are remembered, so the same text is not judged twice.
  - The two results are put together (`apps/web/src/asked.ts`): one reminder per thread, `same` first, two at most.
  - It uses the key and provider the learner already uses for answers; nothing goes anywhere new. A failed or unreadable reply shows nothing.
  - `pnpm asked:check` replays a notebook's questions through both checks and prints what would have been flagged, for judging and tuning on one's own notebook.
- **Matching by words compares subject words** (`packages/core/src/asked.ts`, pure and tested).
  - A question is its text plus the passage it is about: "what is this?" on a selected passage has its subject in the passage. An earlier exchange also counts its thread's title and its one-line headline.
  - Words that ask, point or are polite are dropped, in English and Chinese ("what is", "explain", 是什么, 一下); Chinese and Japanese are compared as overlapping pairs of characters; a word found all over the notebook counts less than a rare one.
  - A match needs most of what was typed to be in the earlier exchange (75% by weight) and that exchange to be about it, not just mention it; or the whole earlier question to be inside the new one. `same` when it reads as the same question, `related` when its subject was asked about there. At most two reminders, one per thread.
  - Never the thread being asked in, nor the threads it came from; never the Trash.
- **It reminds; it never blocks.** While a question is written in a new thread, a side question or a question about a source, a quiet line above the box says **You asked this before** (or *about this*), with the earlier question, its thread, date and headline, and three ways on: **Open it** (the earlier exchange; the draft is kept), **Ask there** (the question is sent in the earlier thread, after what was said there; no thread is made), or just ask (the reminder can be dismissed with ×). A new thread is not saved until its first question is sent, so following a reminder adds nothing.
- **A side question on a passage already asked about** shows the earlier one before anything is typed (the passage alone matches).
- **A thread that already has a note** says so when **Turn into a note** is pressed, with *write another*.
- **Not while following up** in an existing thread: a follow-up is not a new item.
- **Measured without words.** `asked_before.shown`, `.opened`, `.asked_there`, `.asked_anyway`, `.dismissed` are logged with the strength, the place and how it was found (words or meaning); `asked_before.judged` with how many questions were read and how many the model named. Never the words.
- `POST /api/notebooks/:id/asked {text, passage?, threadId?}` returns the hits; it reads every question of the notebook each time, which is fine at this size.

## Consequences

- Each new question written with a pause costs one small model call, and the reminder by meaning comes a second or two after the pause; a question sent at once gets only the word check.
- The prompt has been tried only with the fake model in tests. How well a real model judges, and whether it over-reminds, is to be seen in use and with `pnpm asked:check`; the wording of the prompt is the thing to tune.
- A very large notebook sends a long list (300 questions is roughly 10,000 tokens, mostly read from the provider's cache). Choosing candidates first is the next step if that costs too much.
- The word thresholds were set on made-up cases and checked on the founder's notebook; the log says how often a reminder is dismissed.
- A reminder can be wrong; it costs one glance and is dismissed with ×.

## How to reverse

Remove `<AskedBefore>` from `DraftView` and the routes; to drop only the model's reading, remove the second effect in `AskedBefore.tsx`. Nothing is stored except log lines.
