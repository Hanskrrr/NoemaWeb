-- Rooms with room for links (ADR 0027, 2026-11-13 addendum): columns of
-- clusters now stand 128px apart, not 28, so the words of a link fit between
-- them. Clusters placed before keep their order and their rows; their columns
-- move apart in proportion (from 24 + n * 292 to 24 + n * 392). Clusters that
-- grew into each other are set apart by the room page itself.
UPDATE room_item
SET x = 24 + ROUND((x - 24) * 392.0 / 292.0)
WHERE x IS NOT NULL AND x > 24;
