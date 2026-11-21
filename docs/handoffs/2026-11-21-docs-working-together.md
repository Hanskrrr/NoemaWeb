# Handoff 2026-11-21: working together (branches and merges)

**What prompted it.** The founder wants others to join, people and their AI agents, each taking a piece of the work. The pieces are in the draft "Who can take what", sent as a PDF and saved in the project as `NOEMAWEB_WORKSTREAMS_DRAFT.md`; it is not decided yet. He then asked: "add guide about collab in some files, like branch out and merge rule." ADR 0039.

## What changed (docs only, no code)

- **CONTRIBUTING.md** has a new section, "Branches and merges":
  - Start from `main`: say what you are taking first, and name the branch `area/what-it-does` (areas listed), one piece of work per branch.
  - While you work: merge `main` in to keep up, don't rebase once pushed, never force-push, and try a migration on a copy of the notebook (`NOEMA_DB_PATH`).
  - Pull requests: a draft first, then the template.
  - Review and merge: the founder merges with a merge commit, and his approval is needed for the fence, ADRs, migrations, `contract.ts` and `AGENTS.md`.
  - A table of the files many people change: ADR and migration numbers, status and codebase, handoff names, the push log.
  - What to do when `main` breaks.
  - AI agents follow the same rules.
  - A "For now" note: until `notebook-features` is merged into `main`, start from it.
- **AGENTS.md**, Workflow: the same rules in short. The old "push and open pull requests only when the founder asks" now applies only to AI agents (pushing only when the person running them asks). The push log records only merges into and pushes of `main`.
- **`.github/pull_request_template.md`**: the checklist every pull request fills in.
- **ADR 0039**, branches and merges.
- **The rest:**
  - README links to the new section;
  - codebase.md lists the template;
  - push-log.md says who writes it now.

## Verified

- Docs only: no code or tests changed. Unit tests and e2e were not rerun.
- The commands in the guide were checked against the code:
  - `NOEMA_DB_PATH` is read in `apps/server/src/config.ts`;
  - migrations are tracked by number in `user_version` (`apps/server/src/store/db.ts`);
  - CI runs on pull requests and on pushes to `main` (`.github/workflows/ci.yml`).

## Not done: for the founder

1. Merge `notebook-features` into `main` (by pull request, so CI runs on it), push `main`, then delete the "For now" note in CONTRIBUTING.md.
2. On GitHub, protect `main`: require a pull request and the `check` job, and allow no force-pushes. Until then the rules are only written.
3. CI still installs without `--frozen-lockfile`, and its comment says no lockfile is committed. That waits on the uncommitted change to `pnpm-lock.yaml` on the Mac.
4. Decide on the pieces in "Who can take what", and who takes which.

## Next

Engineering health (piece A of the draft), if the founder says so: the pull request into `main`, a frozen lockfile, and the large files (`repo.ts`, `app.ts`, `contract.ts`, `styles.css`) split by area, so several people can work without colliding.
