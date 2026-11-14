-- Sources from the web (ADR 0031): what a search of the web found while a
-- question was answered in a room, or for what is still open in a room. Kept
-- so the learner can add a page to the room (it becomes a source) or dismiss
-- it. "web" on a room says whether questions asked in it may search.
CREATE TABLE web_find (
  id TEXT PRIMARY KEY,
  notebook_id TEXT NOT NULL REFERENCES notebook(id) ON DELETE CASCADE,
  room_id TEXT REFERENCES room(id) ON DELETE CASCADE,
  revision_id TEXT REFERENCES message_revision(id) ON DELETE CASCADE,
  n INTEGER NOT NULL,
  query TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  snippet TEXT NOT NULL,
  summary TEXT NOT NULL,
  site TEXT,
  date TEXT,
  score REAL,
  status TEXT NOT NULL DEFAULT 'found' CHECK (status IN ('found', 'added', 'dismissed')),
  source_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX web_find_revision ON web_find(revision_id);
CREATE INDEX web_find_room ON web_find(room_id);
ALTER TABLE room ADD COLUMN web INTEGER NOT NULL DEFAULT 1;
