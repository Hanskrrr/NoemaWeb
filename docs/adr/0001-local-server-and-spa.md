# 0001. A local server and a single-page app, in one repository

Date: 2026-11-04. Status: accepted.

## Context

Noema v0.1 is single-user and local. Answers must survive a closed tab and a restarted machine. Model API keys must not sit in browser JavaScript. Search needs a real index.

## Decision

- A Node server (`apps/server`) owns the store (SQLite), model calls and streaming. It listens on 127.0.0.1 only.
- A React single-page app (`apps/web`) is served by Vite in development and by the server in production. It talks to the server over `/api` (JSON plus server-sent events).
- Shared types and rules live in `packages/core`, used by both.
- One pnpm workspace, one Git repository.

## Consequences

- Generation runs on the server, so closing or reloading the tab never stops an answer. The tab reconnects and gets a snapshot, then deltas.
- The key stays in `.env` on the server.
- There is no login. Safety comes from binding to loopback and checking Host, Origin and a custom header (see `apps/server/src/http/guard.ts`).
- A desktop shell or an MCP server can later reuse the same server unchanged.

## How to reverse

Moving to a hosted, multi-user service would need auth, per-user stores and a real deployment. That is out of scope for v0.1 (brief §4).
