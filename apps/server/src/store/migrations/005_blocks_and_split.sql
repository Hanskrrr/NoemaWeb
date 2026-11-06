-- Notes become blocks the learner edits in place, and a branch can be made
-- its own thread.

-- Set when a branch was made its own thread: listed at the top level, with
-- its own map and notes. NULL for a branch still in place, and for threads
-- that were never branches.
ALTER TABLE thread ADD COLUMN split_at TEXT;

-- One block of a note: a paragraph, heading, list, table, formula or code.
-- note.content keeps the blocks joined, for export and the notes list.
CREATE TABLE note_block (
  id                   TEXT PRIMARY KEY,
  note_id              TEXT NOT NULL REFERENCES note(id) ON DELETE CASCADE,
  pos                  INTEGER NOT NULL,
  content              TEXT NOT NULL DEFAULT '',
  author               TEXT NOT NULL CHECK (author IN ('ai', 'user', 'ai+user')),
  -- An AI suggestion for this block. It changes nothing until the learner
  -- accepts it. A block added by "Ask AI" has empty content until then.
  proposal             TEXT,
  proposal_status      TEXT CHECK (proposal_status IN ('generating', 'ready', 'failed')),
  proposal_instruction TEXT,
  proposal_error       TEXT,
  -- Deleted blocks are kept, so a delete can be undone.
  deleted_at           TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
) STRICT;
CREATE INDEX note_block_by_note ON note_block(note_id, pos);

-- Each version of a note records what changed and the blocks it had.
ALTER TABLE note_revision ADD COLUMN change TEXT NOT NULL DEFAULT '';
ALTER TABLE note_revision ADD COLUMN blocks TEXT;
