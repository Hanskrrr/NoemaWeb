-- What a room adds up to (ADR 0030): the brief the AI writes from the
-- summaries of what is in it, and the questions still open there. One per
-- room; "basis" says which summaries it was written from, so a brief written
-- before they changed is shown as older.
CREATE TABLE room_brief (
  room_id TEXT PRIMARY KEY REFERENCES room(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  open TEXT NOT NULL DEFAULT '[]',
  basis TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL
);
