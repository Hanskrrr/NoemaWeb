# 0002. Node built-ins for HTTP, SQLite, tests and TypeScript

Date: 2026-11-04. Status: accepted for M0 and M1; revisit at M3.

## Context

The architecture handoff proposed Hono, better-sqlite3, Vitest and a TypeScript build step. Node 22.18+ now ships what the server needs:

- `node:http` for a small local API;
- `node:sqlite` (SQLite 3.50 with FTS5), synchronous like better-sqlite3;
- `node:test` with a spec reporter;
- type stripping, so `.ts` files run directly.

M0 was also scaffolded in a sandbox that could not reach the npm registry. With built-ins, every server line could be run and tested there, not just written.

## Decision

- `apps/server` uses `node:http`, `node:sqlite` and `node:test`, and runs from source with type stripping. Only TypeScript-erasable syntax is allowed (`erasableSyntaxOnly`): no enums, no parameter properties.
- Runtime dependencies are `zod` and `@noema/core`. Nothing native to compile.
- `apps/web` still uses Vite and React; the browser needs a bundler.

## Consequences

- No native module builds (better-sqlite3 needs prebuilt binaries per Node version and platform), no build step, a fast `pnpm install`.
- `node:sqlite` is not yet marked stable; Node 22 prints an ExperimentalWarning when it loads, so the server starts with `--disable-warning=ExperimentalWarning`. All database access goes through `store/db.ts` and `store/repo.ts`, so a change in its API touches two files.
- The router is about 120 lines. Routes are few and local, and Zod does the validation that a framework would.
- `node:test` lacks some Vitest conveniences (watch UI, snapshot files). Fine at this size.

## How to reverse

- SQLite: better-sqlite3's API is nearly the same (`prepare`, `run`, `get`, `all`, `exec`). Replace the `DatabaseSync` import in `db.ts`.
- HTTP: Hono runs on `node:http` through `@hono/node-server`; the handlers map one to one.
- Tests: Vitest can run `node:test`-style files with small edits (`describe`/`it` imports).
