-- What was sent with each model call: the exact messages, so "what did the
-- model see?" can be shown word for word. Calls made before this have none.
ALTER TABLE model_call ADD COLUMN request TEXT;
