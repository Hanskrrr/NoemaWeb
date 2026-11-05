// Two servers run during e2e, both with an in-memory store:
// one with the fake model (deterministic answers, no network), and one with
// no model connected, for the first-run flow.
export const FAKE_PORT = 8799;
export const FRESH_PORT = 8798;
export const FRESH_URL = `http://127.0.0.1:${FRESH_PORT}`;
