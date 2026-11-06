-- Where a thread's title came from: its first question (the default, set
-- when it is asked), the model (a short title written after the first
-- answer), or the learner (renamed by hand; never overwritten).
ALTER TABLE thread ADD COLUMN title_source TEXT NOT NULL DEFAULT 'question';
