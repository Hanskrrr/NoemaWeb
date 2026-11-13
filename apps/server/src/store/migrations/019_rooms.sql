-- Rooms (ADR 0026): what is learnt about one subject, set together whatever
-- kind it is. A room holds what was put in it by hand; what comes with that
-- (the threads about a source, the notes made from a thread) is worked out
-- when the room is drawn, not stored.

CREATE TABLE room (
  id          TEXT PRIMARY KEY,
  notebook_id TEXT NOT NULL REFERENCES notebook(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
) STRICT;
CREATE INDEX room_by_notebook ON room(notebook_id, created_at);

-- A thing in a room, by kind and id (a thread, a source or a note; not a
-- foreign key, so the Trash and the room do not fight: what is in the Trash is
-- simply not drawn). state: 'in', put in by hand; 'out', came with something
-- in the room and was taken out; 'placed', only where it sits on the map.
CREATE TABLE room_item (
  room_id    TEXT NOT NULL REFERENCES room(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('thread', 'source', 'note')),
  item_id    TEXT NOT NULL,
  state      TEXT NOT NULL CHECK (state IN ('in', 'out', 'placed')),
  x          REAL,
  y          REAL,
  added_by   TEXT NOT NULL DEFAULT 'you' CHECK (added_by IN ('you', 'assistant')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (room_id, kind, item_id)
) STRICT;
CREATE INDEX room_item_by_item ON room_item(kind, item_id);
