# Handoff 2026-11-05: AI titles and tables

## What changed

- **Tables and the rest of GitHub Markdown.** The founder's DeepSeek answers use tables in 6 of 8 answers, and they rendered as lines of `|`. The renderer now uses `micromark-extension-gfm` and `mdast-util-gfm`: tables (with column alignment, horizontal scroll when wide, math and code inside cells), ~~strikethrough~~, task lists, footnotes and bare links. Every table cell keeps the character-to-source mapping, so selecting text in a table and asking in a branch anchors exactly.
- **Single tildes are not strikethrough.** Chinese text writes ranges as `3~5 天`; with GitHub's default, two ranges on one line would be struck through.
- **AI-written titles.** After a thread's or branch's first answer, the model writes a short title (at most 8 words, or 16 Chinese characters, in the question's language). Branch titles also see the passage they came from. The title is written before the answer's stream ends, so the sidebar shows it right away. Threads from before this change are titled once, in the background, when the server starts. Titles are searchable. A title the learner sets will never be overwritten (`thread.title_source`: `question`, `model` or `user`; migration 003). Renaming in the UI is not built yet.
- **Cheaper titles on DeepSeek.** Title calls ask DeepSeek to skip its thinking step (`thinking: {type: "disabled"}`), and only DeepSeek gets that field, since other providers can reject unknown fields. Titles are capped at 60 output tokens.

## Verified

See the final message of the session for the exact counts; the commands are `pnpm test` and `pnpm e2e`.

## Next

- Rename a thread by hand (sets `title_source = 'user'`).
- Regenerate as a new revision; code highlighting; showing DeepSeek's reasoning.
- M3: sources.
