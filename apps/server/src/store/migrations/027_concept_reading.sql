-- The concept-reading skill (ADR 0037). Concepts are read from every piece of
-- every material and joined across the notebook: a concept is notebook-wide
-- now, in every room whose materials mention it, not a room's door.

-- The pieces of a material read so far, by the hash of their words (and the
-- skill's version). A piece whose hash is here is not read again.
CREATE TABLE concept_piece (
  notebook_id TEXT NOT NULL REFERENCES notebook(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('source', 'thread', 'note')),
  item_id     TEXT NOT NULL,
  hash        TEXT NOT NULL,
  model       TEXT NOT NULL,
  read_at     TEXT NOT NULL,
  PRIMARY KEY (kind, item_id, hash)
) STRICT;

-- Where a material discusses a concept: the words (and where they are), what
-- it does with it, what it says of it. Read from a piece by the AI, or put by
-- the learner (no piece). Not yet joined to a concept: a passing idea.
CREATE TABLE concept_mention (
  id          TEXT PRIMARY KEY,
  notebook_id TEXT NOT NULL REFERENCES notebook(id) ON DELETE CASCADE,
  concept_id  TEXT REFERENCES room(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('source', 'thread', 'note')),
  item_id     TEXT NOT NULL,
  hash        TEXT,
  piece_at    INTEGER NOT NULL DEFAULT 0,
  name        TEXT NOT NULL,
  key         TEXT NOT NULL,
  also        TEXT NOT NULL DEFAULT '[]',
  role        TEXT NOT NULL CHECK (role IN ('defines', 'explains', 'uses', 'example', 'asks')),
  quote       TEXT NOT NULL,
  says        TEXT,
  target      TEXT,
  made_by     TEXT NOT NULL CHECK (made_by IN ('you', 'ai')),
  created_at  TEXT NOT NULL
) STRICT;
CREATE INDEX concept_mention_item ON concept_mention(kind, item_id);
CREATE INDEX concept_mention_concept ON concept_mention(concept_id);
CREATE INDEX concept_mention_key ON concept_mention(notebook_id, key);

-- The names that mean a concept: its own, the other names found for it, and
-- those of concepts the learner merged into it. Renaming keeps the old name.
CREATE TABLE concept_name (
  concept_id TEXT NOT NULL REFERENCES room(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  name       TEXT NOT NULL,
  made_by    TEXT NOT NULL CHECK (made_by IN ('you', 'ai')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (concept_id, key)
) STRICT;
CREATE INDEX concept_name_key ON concept_name(key);

-- Names the learner dismissed (or removed, or made a room of): never
-- suggested as a concept again.
CREATE TABLE concept_dismissed (
  notebook_id TEXT NOT NULL REFERENCES notebook(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (notebook_id, key)
) STRICT;

-- The mention a concept is defined by, so another is taken when it goes.
ALTER TABLE room ADD COLUMN definition_mention TEXT;

-- Links between concepts belong to the notebook now, not to one room.
CREATE TABLE concept_link_new (
  id          TEXT PRIMARY KEY,
  notebook_id TEXT NOT NULL REFERENCES notebook(id) ON DELETE CASCADE,
  from_id     TEXT NOT NULL REFERENCES room(id) ON DELETE CASCADE,
  to_id       TEXT NOT NULL REFERENCES room(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('explains', 'example-of', 'builds-on', 'contrasts-with', 'same-question', 'part-of', 'related')),
  why         TEXT,
  made_by     TEXT NOT NULL CHECK (made_by IN ('you', 'ai')),
  status      TEXT NOT NULL CHECK (status IN ('suggested', 'accepted')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  CHECK (from_id <> to_id)
) STRICT;
INSERT INTO concept_link_new (id, notebook_id, from_id, to_id, kind, why, made_by, status, created_at, updated_at)
  SELECT l.id, r.notebook_id, l.from_id, l.to_id, l.kind, l.why, l.made_by, l.status, l.created_at, l.updated_at
  FROM concept_link l JOIN room r ON r.id = l.room_id;
DROP TABLE concept_link;
ALTER TABLE concept_link_new RENAME TO concept_link;
CREATE INDEX concept_link_by_notebook ON concept_link(notebook_id);

-- Concepts of ADR 0036: what was dismissed in a room is dismissed in its
-- notebook (names are keyed again, the code's way, when concepts are next
-- read); their things put by hand stay; they are not doors of a room any more.
INSERT OR IGNORE INTO concept_dismissed (notebook_id, key, name, created_at)
  SELECT r.notebook_id, lower(trim(j.value)), j.value, cr.updated_at
  FROM concept_reading cr JOIN room r ON r.id = cr.room_id, json_each(cr.dismissed) j
  WHERE trim(j.value) <> '';
DROP TABLE concept_reading;
DELETE FROM room_door WHERE child_id IN (SELECT id FROM room WHERE kind = 'concept');
