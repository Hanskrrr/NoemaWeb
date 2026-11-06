-- Branches: a thread asked from a passage of another thread.
-- The anchor pins the exact revision that was shown, with W3C quote and
-- position selectors, so the origin can always be found again or reported
-- as unresolved, never guessed.

CREATE TABLE anchor (
  id            TEXT PRIMARY KEY,
  message_id    TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  revision_id   TEXT NOT NULL REFERENCES message_revision(id) ON DELETE CASCADE,
  exact         TEXT NOT NULL,
  prefix        TEXT NOT NULL,
  suffix        TEXT NOT NULL,
  start_offset  INTEGER NOT NULL,
  end_offset    INTEGER NOT NULL,
  created_at    TEXT NOT NULL,
  CHECK (start_offset >= 0 AND end_offset > start_offset)
) STRICT;
CREATE INDEX anchor_by_message ON anchor(message_id);

ALTER TABLE thread ADD COLUMN parent_thread_id TEXT REFERENCES thread(id) ON DELETE CASCADE;
ALTER TABLE thread ADD COLUMN origin_anchor_id TEXT REFERENCES anchor(id);
CREATE INDEX thread_by_parent ON thread(parent_thread_id);
