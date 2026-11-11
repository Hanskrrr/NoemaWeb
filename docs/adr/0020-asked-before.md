# 0020. Asked before: a reminder before a new thread, side question or note

Date: 2026-11-11. Status: accepted.

## Context

The founder's principle: do not add threads or notes that are not needed. If something was asked before and the learner starts a new thread to ask it again, Noema should say it is already somewhere, so the notebook does not fill with repeats. The brief has this as insight I2, "You've asked this before".

Two questions decide whether it helps or nags: how a repeat is recognised without embeddings (out of scope for v0.1), and what the reminder may do.

## Decision

- **Matching compares subject words** (`packages/core/src/asked.ts`, pure and tested).
  - A question is its text plus the passage it is about: "what is this?" on a selected passage has its subject in the passage. An earlier exchange also counts its thread's title and its one-line headline.
  - Words that ask, point or are polite are dropped, in English and Chinese ("what is", "explain", 是什么, 一下); Chinese and Japanese are compared as overlapping pairs of characters; a word found all over the notebook counts less than a rare one.
  - A match needs most of what was typed to be in the earlier exchange (75% by weight) and that exchange to be about it, not just mention it; or the whole earlier question to be inside the new one. `same` when it reads as the same question, `related` when its subject was asked about there. At most two reminders, one per thread.
  - Never the thread being asked in, nor the threads it came from; never the Trash.
- **It reminds; it never blocks.** While a question is written in a new thread, a side question or a question about a source, a quiet line above the box says **You asked this before** (or *about this*), with the earlier question, its thread, date and headline, and three ways on: **Open it** (the earlier exchange; the draft is kept), **Ask there** (the question is sent in the earlier thread, after what was said there; no thread is made), or just ask (the reminder can be dismissed with ×). A new thread is not saved until its first question is sent, so following a reminder adds nothing.
- **A side question on a passage already asked about** shows the earlier one before anything is typed (the passage alone matches).
- **A thread that already has a note** says so when **Turn into a note** is pressed, with *write another*.
- **Not while following up** in an existing thread: a follow-up is not a new item.
- **Measured without words.** `asked_before.shown`, `.opened`, `.asked_there`, `.asked_anyway`, `.dismissed` are logged with the strength and the place only, to learn whether reminders are followed.
- `POST /api/notebooks/:id/asked {text, passage?, threadId?}` returns the hits; it reads every question of the notebook each time, which is fine at this size.

## Consequences

- Words only: a question with the same meaning in other words ("why scale attention?" against "why divide by √d_k?") is missed. If real use shows that this matters, embeddings are the founder's decision (the scope fence).
- The thresholds were set on made-up cases and checked on the founder's notebook; they may need tuning with more use. The log says how often a reminder is dismissed.
- A reminder can be wrong; it costs one glance and is dismissed with ×.

## How to reverse

Remove `<AskedBefore>` from `DraftView` and the route. Nothing is stored except log lines.
