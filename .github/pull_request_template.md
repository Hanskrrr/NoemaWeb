<!-- Title: what it does, in a few words. Add the ADR number if it adds one, e.g. "ADR 0040: memory you keep". -->

## What and why

<!-- What changed, and why. Link the issue or the piece of work it belongs to. -->

## How it was checked

<!-- What you ran and what passed (pnpm check, pnpm e2e, by hand). Screenshots for anything you can see, light and dark. -->

## Not checked

<!-- What you could not check, said plainly (e.g. a real model, Safari). -->

## Checklist

- [ ] The branch is from `main` and named `area/what-it-does`; `main` is merged in and the conflicts are resolved
- [ ] `pnpm check` and `pnpm e2e` pass; CI is green
- [ ] New behaviour has tests; a bug fix starts with a failing test; tests use the fake model only
- [ ] A new decision has an ADR (the next free number; renumbered if `main` took it)
- [ ] A new migration has the next free number, and was tried on a copy of the notebook, not `data/noema.db`
- [ ] The session has a handoff in `docs/handoffs/`; `docs/status.md` and `docs/codebase.md` are updated for this work only
- [ ] No private data: nothing from `data/`, no keys, no real notebook content
- [ ] Made with an AI agent? The person who ran it has reviewed the changes
- [ ] Needs the founder's approval? (the scope fence, an ADR, a migration, `contract.ts`, `AGENTS.md`)
