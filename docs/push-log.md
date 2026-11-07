# Push log

How each push to GitHub (`Hanskrrr/NoemaWeb`) was made, so the next one can be made the same way. Newest first. Add an entry for every push: what, the checks before it, how, and the result.

## Next push: `notebook-features`, guides for collaborators

- **What.** Three commits on top of `1bf0921`: guides for collaborators (`docs/architecture.md`, `docs/codebase.md`, `CONTRIBUTING.md`, a fuller `docs/status.md`, links from the README and AGENTS.md), and this log. Docs only.
- **Checks before pushing.** `node --test`: 185 pass. Every relative link in the new docs resolves. No notebook content in them.
- **How.** A plain push from the Mac; no force needed:

  ```sh
  cd ~/Code/CodeFactory/AgenticSys/NoemaLearningNote/NoemaWeb
  git push origin notebook-features
  ```

- **Result.** Not pushed yet. Record here the commit pushed, when, and by whom.

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
