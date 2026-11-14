-- Rooms in rooms (ADR 0032): a room put in another, drawn there as a door
-- (where it sits on the bigger room's map). A room can be in many rooms, never
-- in itself at any depth (checked when it is put in). Taking a room down takes
-- its doors with it; the rooms that were inside it stay.
CREATE TABLE room_door (
  room_id    TEXT NOT NULL REFERENCES room(id) ON DELETE CASCADE,
  child_id   TEXT NOT NULL REFERENCES room(id) ON DELETE CASCADE,
  x          REAL,
  y          REAL,
  added_by   TEXT NOT NULL DEFAULT 'you' CHECK (added_by IN ('you', 'assistant')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (room_id, child_id),
  CHECK (room_id <> child_id)
) STRICT;
CREATE INDEX room_door_by_child ON room_door(child_id);
