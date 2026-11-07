# 0018. Export and import: the whole store, table by table

Date: 2026-11-07. Status: accepted.

## Context

M5 in the prototype brief: JSON and Markdown export, with import that round-trips. A JSON export existed (`GET /api/export`, version 1), but it named a fixed list of tables and had fallen behind the schema: no sources, no merges. Nothing could import it.

Two designs were possible for the JSON: a model of the notebook (threads containing messages containing revisions…), or the tables as they are. A model reads better but needs its own code to write and to read back, and every new feature must remember to extend both. The tables are already the truth, with their constraints.

## Decision

- **The tables, as they are.** Version 2 of the export is `{format: 'noema-export', version: 2, exportedAt, schemaVersion, tables: {name: rows}}`: every table in the store, found from `sqlite_master`, except the search index (rebuilt from the rest) and `meta` (facts about the store itself). Rows in the order they were written. A new table is exported without any change here. The model key is not in the store, so not in the export (a test checks).
- **Import into an empty store only.** `POST /api/import` (up to 512 MB) refuses a store that has threads, notes, sources or About you: merging two notebooks is a different feature, with its own questions (two notebooks? which About you?). The default notebook an empty store makes at start is replaced by the imported one.
- **Same schema version, checked whole.** The export's `schemaVersion` must be the store's: an export from another version is refused with a sentence saying so. Every table name and column is checked against the store (`PRAGMA table_info`), values must be text, numbers or null, and foreign keys are checked at the end of the one transaction (`PRAGMA defer_foreign_keys`), so an export that does not hold together changes nothing. Afterwards, as after a restart: answers that were being written are marked interrupted, notes and merge drafts that were being written are marked failed, and the search index is rebuilt.
- **Markdown for reading.** `GET /api/notebooks/:id/export.md`: About you, the notes (with what each citation cites), every thread with its side questions under it and the passage each was asked about, then the sources. Answers are the ones in use; the Trash is left out. Headings inside answers and notes are moved down so they sit under the file's own (`demoteHeadings`, in core). It cannot be imported.
- **In the app.** **Export** in the header opens one dialog: download a copy, download Markdown, import a copy. After an import the app reloads into the imported notebook.

## Consequences

- An export is only as old as the schema it came from. To import an older export, open it with the Noema version that made it and export again after upgrading; migrating exports themselves is left for when someone needs it.
- Exports hold every request sent to the model (ADR 0016), so they grow with use.
- Version 1 exports cannot be imported (they missed tables).

## How to reverse

Remove the import route and the dialog's import section; the export stays useful as a backup on its own.
