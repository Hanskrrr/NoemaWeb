# Push log

How each push to GitHub (`Hanskrrr/NoemaWeb`) was made, so the next one can be made the same way. Newest first. Add an entry for every push: what, the checks before it, how, and the result.

## Next push: `notebook-features`, the concept-reading skill and concepts in levels

- **What.** The commits on top of `ca717e6`:
  - the concept-reading skill (ADR 0037: concepts read from every piece of every material, joined notebook-wide, updated by hash; migration 027), with its fix and docs;
  - concepts in levels on a map that zooms (ADR 0038: threads and notes only, topics and kinds, a concept you make filled, Stop; migration 028), with its docs and this entry.

  No force needed: `origin/notebook-features` (`ca717e6`) is an ancestor.
- **Checks before pushing.** See the handoffs 2026-11-20-concept-reading and 2026-11-21-concept-levels:
  - `node --test` 401 pass in the sandbox, and on the Mac (its Linux shell) after the bundle;
  - tsc clean;
  - Playwright 92 of 92 in the sandbox;
  - `pnpm lint` (Biome) not run.
  - No `data/`, `.env`, `*.db`, settings, keys or local paths in the range; made-up text only.
  - The uncommitted `pnpm-lock.yaml` and AOCI setup on the Mac are left out, as before.
- **How.** As below: from the Mac's Terminal, `git push origin notebook-features`.
- **Result.** Not pushed yet. Record here the commit pushed, when, and by whom.

## 2026-11-19: `notebook-features`, reading rooms to concepts

- **What.** 18 commits on top of `cfb2256`: 17 of work, and the one that adds this entry. The work is:
  - reading a room (ADR 0027) and its overlaps fixed (addendum);
  - the Assistant floating (ADR 0028);
  - links drawn by dragging, Review and colours (ADR 0029);
  - the room's brief (ADR 0030);
  - sources from the web (ADR 0031);
  - rooms in rooms (ADR 0032);
  - the Assistant acting on its own (ADR 0033);
  - deleting for good (ADR 0034);
  - ways to see a room (ADR 0035);
  - concepts (ADR 0036).

  Migrations 020 to 026. 94 files, about 14,400 lines added (before this entry). No force needed: `origin/notebook-features` (`cfb2256`) is an ancestor.
- **Checks before pushing.**
  - `node --test` (core, server, web): 376 pass, in the sandbox and on the Mac (its Linux shell).
  - tsc clean in the sandbox for core, server, web and the root project.
  - Playwright in the sandbox: 90 tests. The room tests passed in every full run. Each run had one different failure elsewhere (files, sources, the thread map), which passed when rerun (handoff 2026-11-19-ways-to-see-a-room).
  - `pnpm lint` (Biome) not run.
  - No `data/`, `.env`, `*.db` or settings file in the range. No key-like strings or private keys in `git log -p cfb2256..`. No local paths. Every commit by WU Jinyu, with the Claude co-author lines. Made-up text only in tests and docs.
  - Not in the push, and left as they are on the Mac: the uncommitted `pnpm-lock.yaml` change, and the uncommitted AOCI setup (`AGENTS.md`'s AOCI block, `.gitignore`, `.aoci/`, `aoci*.txt`, its handoff).
- **Tried from the Claude session: no route.**
  - The sandbox: adding the repository with push access needs the GitHub account linked to Claude ("link your GitHub account").
  - The bridge to the Mac: GitHub is not on its allow list (SSH to github.com:22 refused, HTTPS 403 from the proxy).
- **How.** A plain push from the Mac's Terminal, with his SSH key:

  ```sh
  cd ~/Code/CodeFactory/AgenticSys/NoemaLearningNote/NoemaWeb
  git log --oneline -1            # docs: push log …
  git push origin notebook-features
  ```

- **Result.** Pushed by the founder from his Mac with `git push origin notebook-features`: `origin/notebook-features` is `ca717e6`, at 2026-11-19 08:40:39 −08:00 (from the Mac's reflog of the remote-tracking ref).

## 2026-11-13: `notebook-features`, asked before, PDF sources, the Assistant and rooms

- **What.** The commits on top of `5bb1ccb`: "asked before" by words and by the chat model reading for meaning (ADR 0020), `pnpm asked:check`; the study-structure draft (docs only); PDF sources and pages (ADRs 0021, 0022, migrations 014 and 015, a new dependency `pdfjs-dist` 6.2.108, made-up PDF fixtures); the Assistant, its frame, the panel beside what is open, and changes it proposes (ADRs 0023, 0024, migrations 016 and 017); and their docs. No force needed.
- **Checks before pushing.** See the 2026-11-11 to 2026-11-13 handoffs: `node --test` and Playwright in the Claude sandbox, tsc on the Mac. Before pushing: `pnpm install` on the Mac (it adds pdf.js and updates `pnpm-lock.yaml`, which should be committed with it), then `pnpm check`. No notebook content in code, tests or docs; the fixture PDFs' metadata names no person or path.
- **How.** A plain push from the Mac:

  ```sh
  cd ~/Code/CodeFactory/AgenticSys/NoemaLearningNote/NoemaWeb
  pnpm install
  git add pnpm-lock.yaml && git commit -m "chore: lockfile for pdfjs-dist"
  git push origin notebook-features
  ```

- **Result.** Pushed by the founder from his Mac: `origin/notebook-features` is `cfb2256` (docs: ADR 0026 and handoff for rooms), so the push also carried the first rooms commits. The Mac's remote-tracking ref was written at 2026-11-13 14:21 UTC. The `pnpm-lock.yaml` commit was not made: the Mac still has the lockfile change uncommitted.

## 2026-11-07: `notebook-features`, guides for collaborators, the rest of M5, and fixes

- **What.** The commits on top of `1bf0921`, up to `5bb1ccb`: guides for collaborators (`docs/architecture.md`, `docs/codebase.md`, `CONTRIBUTING.md`, a fuller `docs/status.md`) and this log; the rest of M5: ask again (ADR 0017), export and import (ADR 0018), pins with migration 013 (ADR 0019); then the fixes of 2026-11-07 (the Sources list, formulas in papers and in answers). No force.
- **Checks before pushing.** `node --test`: 205 pass, in the sandbox and on the Mac. Playwright in the Claude sandbox: 56 pass, twice. tsc on the Mac for core, server, web and the root project. No notebook content in code, tests or docs.
- **How.** A plain push from the Mac: `git push origin notebook-features`.
- **Result.** Pushed by the founder from his Mac: `origin/notebook-features` is `5bb1ccb`. The Mac's remote-tracking ref was written at 2026-11-07 23:44 UTC, which is the time of the push as far as the repository shows.

## 2026-11-06: `notebook-features`, rewritten without the founder's notebook content (force push)

- **Why.** After the first push (below), the founder asked whether local or private data had gone into git. No database, backup, settings file, key or `.env` had; but handoffs and two ADRs quoted his own notebook when describing checks on it: thread and note titles, answer lines, words searched, the subjects he studies, and the paper he added.
- **What.** Every commit of the branch was rewritten in the Claude session (`git filter-branch --tree-filter` with a script of exact replacements, run on `a549514..notebook-features`): only those 14 lines in 10 docs changed; code and tests are identical (checked with `git diff` against the old tip, excluding `docs/` and the README). Counts (threads, messages, blocks) and timings were kept. Then commits on top: a short README, the milestones moved to `docs/status.md`, and this entry. The new tip reached the Mac by bundle and `git reset --keep` (clean working tree); the old local tip is kept as the branch `backup/notebook-features-before-scrub`, never to be pushed.
- **Checks.** `node --test`: 185 pass. `git log -p` of the new branch holds none of the quoted titles, lines, subjects or paper.
- **How it is to be pushed.** It replaces the branch on GitHub, so it needs a force push; only the founder decides that. From the Mac:

  ```sh
  cd ~/Code/CodeFactory/AgenticSys/NoemaLearningNote/NoemaWeb
  git push --force-with-lease=notebook-features:b8dde3d origin notebook-features
  ```

  `--force-with-lease` refuses if GitHub's branch is no longer the `b8dde3d` pushed below. GitHub can still serve the old commits to anyone who has their exact ids until it cleans them up; for full removal, GitHub support can purge them.
- **Result.** Force-pushed by the founder from his Mac with the command above: `1bf0921` (34 commits on `a549514`) replaced `b8dde3d`, at 2026-11-06 20:14:46 −08:00 (from the Mac's reflog). Commit authors were left as they were (`WU Jinyu <jinyudavidwu@gmail.com>`).

## 2026-11-06: `notebook-features`, first push of the branch

- **What.** The branch `notebook-features`: 32 commits on top of `main` at `a549514` (M2 threads and branches, M4 find again, M3 sources, the Trash, the sidebar rail, notes with their material, M5 part 1: what was sent and About you, and the arXiv aligned-equations fix), ending with the commit that adds this log. `main` is not touched; nothing is force-pushed.
- **Checks before pushing.**
  - `node --test` (core, server, web): 185 pass, in the sandbox and on the founder's Mac.
  - `tsc` on core, server, web and root: clean on the Mac.
  - Playwright: 49 pass, twice in a row, in the sandbox. `pnpm lint` (Biome) and `pnpm e2e` have not been run on the Mac.
  - No tracked `data/`, `.env`, `*.db` or settings file; no API-key-like strings in `git log -p a549514..notebook-features`; every commit by WU Jinyu, with the Claude co-author lines.
- **Tried from the Claude session: refused.** The session's git proxy answered 403: `Hanskrrr/NoemaWeb` is not in the session's authorized repositories, so it gives no credential. Adding the repository needs the GitHub account linked to Claude (claude.ai Settings → Connectors). The bridge to the Mac cannot reach github.com either (no DNS for SSH, HTTPS blocked by its proxy).
- **How it is pushed instead: from the Mac, with the founder's SSH key** (the Mac's `origin` is `git@github.com:Hanskrrr/NoemaWeb.git`):

  ```sh
  cd ~/Code/CodeFactory/AgenticSys/NoemaLearningNote/NoemaWeb
  git status                      # clean, on notebook-features
  git log --oneline -1            # docs: push log …
  git push -u origin notebook-features
  ```

  Then, when ready, a pull request `notebook-features` → `main` on GitHub.
- **Result.** Pushed by the founder from his Mac with `git push -u origin notebook-features`: `b8dde3d` (32 commits), at 2026-11-06 20:00:58 −08:00 (from the Mac's reflog). `notebook-features` now tracks `origin/notebook-features`. `main` was not pushed.
