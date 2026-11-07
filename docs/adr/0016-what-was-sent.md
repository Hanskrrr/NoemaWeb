# 0016. What was sent: the exact messages, kept with every answer

Date: 2026-11-06. Status: accepted.

## Context

M5 in the prototype brief: a Context panel that shows exactly what the model was sent, and an About me note that is always in context. Done when the manifest matches the request. Until now each model call kept a manifest (which parts, which messages, estimated tokens) but not the text: About me and the source section could have changed since, so the panel could not have shown the words that were sent.

## Decision

- **Keep the request.** Migration 012 adds `model_call.request`: the exact messages sent, as JSON. Calls made before have none; for those the panel lists the manifest's parts and says the words were not recorded.
- **Split it by the manifest, in core.** `describeSent(manifest, request)` names each part: the instructions, About you and what you are reading (from the system message, by their headings, the source's heading searched from the end since About me may hold anything), each turn of the conversation (inherited or the thread's own, with merged threads), and the question with its passage. Put back together, the parts are the request exactly; a test checks it, and another checks that the request kept is what the model received.
- **`GET /api/messages/:id/context`**: the latest call for an answer's current revision, with the provider's token counts.
- **In the app**: **What was sent** under any answer opens a dialog with each part, its size, and its exact text (the instructions folded away). **About you** in the header is a box of up to 4,000 characters, saved on the notebook and sent with every question; the dialog links to it, and says so when nothing about you was sent.

## Consequences

- Each call stores its messages: a long thread with a source repeats its history in every call. For one learner on one computer this is a few megabytes a month; if it grows, compress the column or keep only the last calls per thread.
- The export (`GET /api/export`) now includes the requests.
- About you is the first layer of the memory proposed for later (statements the learner writes or accepts, with links to where they came from); it is a single text for now.

## How to reverse

Stop writing `request` (the column can stay, null); the dialog then shows the manifest alone.
