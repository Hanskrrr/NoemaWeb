-- Pins: passages the learner keeps in front of the AI. A pin belongs to a
-- thread and is sent with every question there and in its side questions,
-- until it is unpinned (the row is deleted; the log keeps that it was).
-- It points at an exact passage, of a message revision or of a source
-- version, through the same anchor tables as side questions.
CREATE TABLE pin (
  id               TEXT PRIMARY KEY,
  thread_id        TEXT NOT NULL REFERENCES thread(id) ON DELETE CASCADE,
  anchor_id        TEXT REFERENCES anchor(id) ON DELETE CASCADE,
  source_anchor_id TEXT REFERENCES source_anchor(id) ON DELETE CASCADE,
  created_at       TEXT NOT NULL,
  CHECK ((anchor_id IS NULL) <> (source_anchor_id IS NULL))
) STRICT;
CREATE INDEX pin_by_thread ON pin(thread_id, created_at);
