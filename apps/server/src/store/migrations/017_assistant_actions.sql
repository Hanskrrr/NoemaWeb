-- Changes the Assistant proposes (ADR 0024): each waits for the learner's
-- "Do it", and can be cancelled, or undone once done. `payload` holds the
-- checked arguments with ids and offsets resolved; `result` what it made,
-- for Open and Undo.
CREATE TABLE assistant_action (
  id          TEXT PRIMARY KEY,
  message_id  TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL REFERENCES message_revision(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  summary     TEXT NOT NULL,
  payload     TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('proposed', 'running', 'done', 'cancelled', 'failed', 'undone')),
  result      TEXT,
  error       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
) STRICT;
CREATE INDEX assistant_action_by_message ON assistant_action(message_id, seq);

-- Where the learner was when they asked the Assistant (what was open, what
-- they selected), as JSON; null for other questions.
ALTER TABLE message ADD COLUMN place TEXT;
