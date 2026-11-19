-- Concepts (ADR 0036): a concept is a small room, inside the room it was read
-- from (by a door, as rooms in rooms), holding the things about it. The AI
-- suggests concepts when a room is read; they wait, 'suggested', until the
-- learner keeps them. A concept is defined in one sentence, and by the words of
-- one of the learner's things (a point of its summary, where it is).
ALTER TABLE room ADD COLUMN kind TEXT NOT NULL DEFAULT 'room' CHECK (kind IN ('room', 'concept'));
ALTER TABLE room ADD COLUMN status TEXT NOT NULL DEFAULT 'kept' CHECK (status IN ('suggested', 'kept'));
ALTER TABLE room ADD COLUMN definition TEXT;
ALTER TABLE room ADD COLUMN definition_at TEXT;
ALTER TABLE room ADD COLUMN made_by TEXT NOT NULL DEFAULT 'you' CHECK (made_by IN ('you', 'ai'));

-- How the concepts of a room link: what builds on what, what is part of what,
-- what is another way. Suggested by the AI until kept.
CREATE TABLE concept_link (
  id         TEXT PRIMARY KEY,
  room_id    TEXT NOT NULL REFERENCES room(id) ON DELETE CASCADE,
  from_id    TEXT NOT NULL REFERENCES room(id) ON DELETE CASCADE,
  to_id      TEXT NOT NULL REFERENCES room(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('explains', 'example-of', 'builds-on', 'contrasts-with', 'same-question', 'part-of', 'related')),
  why        TEXT,
  made_by    TEXT NOT NULL CHECK (made_by IN ('you', 'ai')),
  status     TEXT NOT NULL CHECK (status IN ('suggested', 'accepted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (from_id <> to_id)
) STRICT;
CREATE INDEX concept_link_by_room ON concept_link(room_id);

-- What a room's reading remembers of its concepts: the names the learner
-- dismissed (not suggested again), and where the AI would put things that are
-- in no concept yet, as [{"item": "kind:id", "concept": id}].
CREATE TABLE concept_reading (
  room_id    TEXT PRIMARY KEY REFERENCES room(id) ON DELETE CASCADE,
  dismissed  TEXT NOT NULL DEFAULT '[]',
  guesses    TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
) STRICT;
