# Handoff 2026-11-11: asked before, by meaning

The founder's judgement on the first version: comparing words instead of meaning is of little use. He chose to let his chat model judge. [ADR 0020](../adr/0020-asked-before.md) is amended.

## What changed

- **The model reads for meaning** (`apps/server/src/chat/asked.ts`). A second after typing pauses in a new thread, a side question or a question about a source, the chat model gets the notebook's earlier questions (each with its passage, the one-line summary of its answer and its thread) and the new question, and names those that already asked it: `same` or `related`, in whatever words or language. `POST /api/notebooks/:id/asked/meaning` returns `{hits, checked}`.
- **Both checks, one reminder.** Words are still compared at once; what the model finds is added when it arrives (one reminder per thread, `same` first, two at most). No model call when the words already say it is the same question, when nothing is typed, or when no model is connected; a failed call shows nothing.
- **Cheap to repeat.** The list of earlier questions comes first in the request and only grows at its end, so the provider's cache holds; the newest 300 at most; the reply is one line.
- **`pnpm asked:check [N]`** replays the notebook's questions (the last N, or all), oldest first, through both checks with the connected model, and prints what would have had a reminder. It writes nothing to the notebook.
- **Log.** Reminder events now say how the hit was found (words or meaning); `asked_before.judged` counts what the model read and named. Never the words.
- **The fake model** judges with a few synonyms ("heavens" is the sky, "azure" is blue), so tests can ask the same thing in words that share nothing.
- AGENTS.md notes the founder's exception to the scope fence.

## Verified

| Check | Result |
| --- | --- |
| `node --test` | 219 pass. New: the request (list first, new question last, unchanged when a question is added); the verdict read from plain JSON, fenced JSON and JSON inside a sentence, numbers outside the list dropped, unreadable replies refused; over HTTP: a repeat with no word in common found by meaning and not by words, in Chinese too, `related`, a new question, not the thread itself, not the Trash, a failing model, the log without words; putting the two results together |
| Playwright (sandbox, Chromium) | 60 pass, twice in a row. New in `asked.spec.ts`: "What makes the heavens azure?" in a new thread is reminded of "Why is the sky blue?" by meaning, and Ask there sends it into that thread |
| `pnpm asked:check` | Run here on a made-up notebook with the fake model: the repeat by meaning and the repeat by words both printed |

## Not verified

- **A real model.** Neither this sandbox nor the bridge to the Mac can call DeepSeek, so the prompt has only met the fake model. Run `pnpm asked:check` on the Mac: it shows what the real model would have flagged on the real notebook. If it reminds too much or too little, the prompt in `apps/server/src/chat/asked.ts` is what to tune.
- `pnpm lint` (Biome) and `pnpm e2e` on the Mac.

## Next

- The founder runs `pnpm asked:check` and uses it; tune the prompt from what he sees.
- Still to discuss: memory beyond About you, and the "new to you" idea.
