// Three servers run during e2e, each with an in-memory store:
// one with the fake model (deterministic answers, no network), one with
// no model connected, for the first-run flow, and an empty one with the
// fake model, to import a copy into.
export const FAKE_PORT = 8799;
export const FRESH_PORT = 8798;
export const FRESH_URL = `http://127.0.0.1:${FRESH_PORT}`;
export const EMPTY_PORT = 8797;
export const EMPTY_URL = `http://127.0.0.1:${EMPTY_PORT}`;
