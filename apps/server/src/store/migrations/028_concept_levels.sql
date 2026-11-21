-- Concepts in levels (ADR 0038). Concepts come from the learner's threads and
-- notes only; sources are no longer read for them. Concepts sit in a tree:
-- topics, the concepts in them, concepts inside concepts.

-- Where a concept is in the tree: under another concept (a kind or a part of
-- it) or in a topic (a concept that holds others). One main home, shown on the
-- map; others are "also under". Suggested by the AI until kept; a home the
-- learner said no to stays, dismissed, so it is not suggested again.
CREATE TABLE concept_home (
  child_id    TEXT NOT NULL REFERENCES room(id) ON DELETE CASCADE,
  parent_id   TEXT NOT NULL REFERENCES room(id) ON DELETE CASCADE,
  notebook_id TEXT NOT NULL REFERENCES notebook(id) ON DELETE CASCADE,
  how         TEXT NOT NULL CHECK (how IN ('kind-of', 'part-of', 'in')),
  status      TEXT NOT NULL CHECK (status IN ('suggested', 'kept', 'dismissed')),
  made_by     TEXT NOT NULL CHECK (made_by IN ('you', 'ai')),
  main        INTEGER NOT NULL DEFAULT 1 CHECK (main IN (0, 1)),
  created_at  TEXT NOT NULL,
  PRIMARY KEY (child_id, parent_id),
  CHECK (child_id <> parent_id)
) STRICT;
CREATE INDEX concept_home_parent ON concept_home(parent_id);
CREATE INDEX concept_home_notebook ON concept_home(notebook_id);

-- What a concept covers, in one line: written by the AI for a concept the
-- learner made (and for topics), the learner's to change. And whether the
-- learner set its place in the tree (even at the top): the AI does not move it.
ALTER TABLE room ADD COLUMN scope TEXT;
ALTER TABLE room ADD COLUMN placed INTEGER NOT NULL DEFAULT 0 CHECK (placed IN (0, 1));

-- What a piece says a concept is under ("AdamW, a variant of Adam"), a hint
-- for the tree; and whether a place is kept: places found for a concept
-- (Find materials) wait, not kept, until the learner keeps them.
ALTER TABLE concept_mention ADD COLUMN under TEXT;
ALTER TABLE concept_mention ADD COLUMN how TEXT CHECK (how IS NULL OR how IN ('kind-of', 'part-of'));
ALTER TABLE concept_mention ADD COLUMN kept INTEGER NOT NULL DEFAULT 1 CHECK (kept IN (0, 1));

-- Where the learner moved a concept on a room's map, relative to what it is
-- under (or to the map, at the top).
CREATE TABLE concept_xy (
  room_id    TEXT NOT NULL REFERENCES room(id) ON DELETE CASCADE,
  concept_id TEXT NOT NULL REFERENCES room(id) ON DELETE CASCADE,
  x          REAL NOT NULL,
  y          REAL NOT NULL,
  PRIMARY KEY (room_id, concept_id)
) STRICT;

-- A concept the learner made in a room is shown there, even before anything
-- is in it.
CREATE TABLE concept_shown (
  room_id    TEXT NOT NULL REFERENCES room(id) ON DELETE CASCADE,
  concept_id TEXT NOT NULL REFERENCES room(id) ON DELETE CASCADE,
  PRIMARY KEY (room_id, concept_id)
) STRICT;

-- Sources are not read for concepts any more: the suggestions only they
-- brought go (not one the learner kept, made or put a thing in by hand), with
-- the AI's places in sources and the record of what was read in them. Places
-- the learner put in a source by hand stay.
DELETE FROM room
WHERE kind = 'concept' AND status = 'suggested' AND made_by = 'ai'
  AND NOT EXISTS (SELECT 1 FROM concept_mention m WHERE m.concept_id = room.id AND (m.kind <> 'source' OR m.made_by = 'you'))
  AND NOT EXISTS (SELECT 1 FROM room_item i WHERE i.room_id = room.id AND i.state = 'in');
DELETE FROM concept_mention WHERE kind = 'source' AND made_by = 'ai';
DELETE FROM concept_piece WHERE kind = 'source';
