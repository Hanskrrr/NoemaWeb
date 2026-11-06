# 0006. Notes cite exchanges with plain labels and a map

Date: 2026-11-05. Status: accepted.

## Context

"Rewrite as note" turns a thread and its branches into a study note. Every claim in the note should lead back to the exchange it came from, and the learner edits the note as Markdown. The first version stored citations as Markdown links (`[E1](noema:message/<thread>/<message>)`). In the editor that put two 26-character ids after every citation, and a citation the learner moved or typed by hand had to be a full link to work.

## Decision

- The note text keeps citations as plain labels, `[E3]`, one per bracket. The model's variants (`[E1, E3]`, `【E1】`) are normalised to that form when the note is finished (`normalizeCitations` in `packages/core`).
- The note stores a map from every label to the exact message (`note.refs`, JSON, set when writing starts). Each version in `note_revision` keeps the map it was written with, because a rewrite numbers the exchanges again.
- The renderer turns a label into a button only inside a note and only when the label is in the map. Labels inside code stay text. In chat, `[E3]` is always text.
- The note's title comes from the `# heading` the model starts with, unless the learner has renamed the note (`note.title_source`: `thread`, `model` or `user`).

## Consequences

- The editor shows readable text, and the learner can cite any exchange of that thread by typing its label.
- A label means nothing outside its note. Copying a note's text elsewhere keeps the labels but not where they point.
- If an exchange is deleted later (not possible yet), its label stops being a button rather than leading nowhere.

## How to reverse

Write the map out as Markdown reference definitions at the end of the text (`[E3]: noema:message/…`) and drop the column; the renderer would then resolve `linkReference` nodes instead of splitting text.
