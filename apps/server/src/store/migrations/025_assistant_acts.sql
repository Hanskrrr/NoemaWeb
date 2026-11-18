-- The Assistant acts on its own (ADR 0033): its changes are done when it makes
-- them, each with Undo, unless the learner asks it to ask first (1 here).
ALTER TABLE notebook ADD COLUMN assistant_asks INTEGER NOT NULL DEFAULT 0;
