-- Reading a room (ADR 0027): a short summary of each thing, written by the
-- AI, with key points that link to the words they came from; and links
-- between things, suggested by the AI or drawn by the learner.

-- One summary per thing, whatever room it is in. basis: what it was written
-- from (a source's version, or when a thread or note last changed), so a
-- summary of an older state is known as such.
CREATE TABLE gist (
  kind       TEXT NOT NULL CHECK (kind IN ('thread', 'source', 'note')),
  item_id    TEXT NOT NULL,
  basis      TEXT NOT NULL,
  text       TEXT NOT NULL,
  points     TEXT NOT NULL DEFAULT '[]',
  model      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (kind, item_id)
) STRICT;

-- A link from one thing to another, read "from <kind> to": "A explains B".
-- Belongs to the notebook, so it shows in every room holding both ends.
-- made_by: you, the AI reading a room, or the Assistant (on Do it).
-- status: suggested (by the AI, not yet looked at), accepted, dismissed (kept,
-- so the same link is not suggested again).
CREATE TABLE item_link (
  id          TEXT PRIMARY KEY,
  notebook_id TEXT NOT NULL REFERENCES notebook(id) ON DELETE CASCADE,
  from_kind   TEXT NOT NULL CHECK (from_kind IN ('thread', 'source', 'note')),
  from_id     TEXT NOT NULL,
  to_kind     TEXT NOT NULL CHECK (to_kind IN ('thread', 'source', 'note')),
  to_id       TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('explains', 'example-of', 'builds-on', 'contrasts-with', 'same-question', 'part-of', 'related')),
  label       TEXT,
  why         TEXT,
  made_by     TEXT NOT NULL CHECK (made_by IN ('you', 'ai', 'assistant')),
  status      TEXT NOT NULL CHECK (status IN ('suggested', 'accepted', 'dismissed')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
) STRICT;
CREATE INDEX item_link_by_notebook ON item_link(notebook_id);
