# 0025. Folders on this computer: files as sources, edited in place, notes in and out

Date: 2026-11-13. Status: accepted.

## Context

The founder asked whether Noema can reach a local folder, then said how he wants it: "as any other agent does": Noema can open and edit the files of a folder, and they all count as sources. He wants to open any file that holds text (PDFs, Markdown, code) "like navigate in cursor or vscode", to export a note into the folder, and to import a file as a note.

Two things in the scope fence (AGENTS.md) are near this: imports from Obsidian, and the step language. A folder of Markdown is close to an Obsidian import. The founder decides exceptions to the fence; this is his decision, recorded here and in AGENTS.md. It is not an Obsidian import: links, front matter and attachments are not read as Obsidian reads them.

Noema runs on loopback for one learner on his own Mac, so the server can read his files. A browser cannot give a web page a folder's path, so the folder is linked by typing (or pasting) its path.

## Decision

- **Linking.** Files, in the sidebar (a folder icon on the rail), links a folder by its whole path (`~` allowed). Finder copies a path with ⌥⌘C. A folder belongs to the notebook (migration 018, `folder`). Unlinking forgets the folder; its files are left as they are, and files opened stay as sources.
- **Listing.** Files lists a folder like a code editor's file list: folders first, then files, by name, opened one level at a time. Hidden entries and generated folders (`node_modules`, `.git`, `dist`, `build`, `__pycache__`, virtual environments, caches) are not listed. Text of any kind, and PDFs, can be opened; anything else (pictures, archives, programs) is shown dimmed.
- **Safety.** Every path is resolved inside the folder. `..` is refused, and so is a link (symlink) that leads outside: the real path must be under the folder's real path. A new file's nearest existing folder must be inside too. Text files up to 2 MB and PDFs up to the PDF limit are read.
- **A file is a source.** Clicking a file opens it as a source linked to it (`source.folder_id`, `source.file_path`): Markdown as it is, any other text as one code block in its language, a PDF as its pages (ADRs 0021, 0022). It is asked about, pinned, cited, searched and quoted like any other source. Each version keeps the hash of the bytes it was read from (`source_version.file_hash`). Opening it again (from Files, from the Assistant, or Read again) reads it again; if it changed on disk, that is a new version, and what was asked stays with the version it was asked about, as with a web page read again.
- **Editing in place.** A text file (not a PDF) has **Edit**: its text as it is on disk, in an editor (code in a monospace face), saved with ⌘S. The save is checked against what was read: if the file changed on disk in between, it is refused and the text typed is kept. A saved file is read again as a new version.
- **Notes in and out.**
  - **Make a note** turns a text file into a note. A Markdown file that opens with a `#` heading takes it as the note's title; its paragraphs and headings become blocks. Code becomes one code block.
  - **Save to a folder** (on a note) writes the note as a Markdown file: its title as a heading, then its blocks, without citation labels (they mean nothing outside the note). It does not write over a file unless the learner says **Replace it**.
- **Every write keeps what it replaced** (`file_backup`): the text before (or that there was no file), and the hash of what was written. Undo puts it back, or removes a file that was new, unless the file changed again since Noema wrote it.
- **The Assistant and files.** The overview tells it which folders are linked. Three lookups need no asking: `list_files` (what is in a folder), `find_in_files` (lines with all the words, in text files, and files named with them; up to 40 hits) and `open_file` (opens the file as a source and reads it, with a label to cite). Four changes are proposals (ADR 0024) that wait for Do it, with Undo: `write_file` (a new file, or a whole new text for one), `edit_file` (replace text that is in the file exactly once), `save_note_to_file` and `note_from_file`. A proposal to change a file shows the change before Do it: the lines taken out and put in, or the new text. Paths it gives start with the folder's name (`Course/week4/notes.md`).

## Consequences

- The text shown is what was on disk when the file was last opened. A file changed elsewhere while it is open is read again only when it is opened again or **Read again** is pressed; there is no file watching.
- A file moved or renamed on disk is a new file to Noema; its old source stays, with what was asked about it. A folder moved or renamed shows as not found until it is linked again.
- Searching (⌘K) finds files only once they are opened as sources. The Assistant's `find_in_files` reads the folder itself, and stops after 4000 files.
- Saving a note into a folder is a copy at that moment. Changing the note later does not change the file; saving again (with Replace it) does.
- The editor is a plain text area: no syntax colours, no undo history across saves. Backups are kept in the database, without a limit for now.
- Biome has not been run on these files (it cannot run in the agent's sandbox).

## How to reverse

Remove the Files section from the sidebar and the file tools from `ASSISTANT_TOOLS`. Linked sources stay readable as ordinary sources (their text is stored). The tables can stay; a later migration can drop `folder` and `file_backup` and the two `source` columns.
