# Push log

How each push to GitHub (`Hanskrrr/NoemaWeb`) was made, so the next one can be made the same way. Newest first. Add an entry for every push: what, the checks before it, how, and the result.

## 2026-11-06: `notebook-features`, first push of the branch

- **What.** The branch `notebook-features`: 33 commits on top of `main` at `a549514` (M2 threads and branches, M4 find again, M3 sources, the Trash, the sidebar rail, notes with their material, M5 part 1: what was sent and About you, and the arXiv aligned-equations fix), ending with the commit that adds this log. `main` is not touched; nothing is force-pushed.
- **Checks before pushing.**
  - `node --test` (core, server, web): 185 pass, in the sandbox and on the founder's Mac.
  - `tsc` on core, server, web and root: clean on the Mac.
  - Playwright: 49 pass, twice in a row, in the sandbox. `pnpm lint` (Biome) and `pnpm e2e` have not been run on the Mac.
  - No tracked `data/`, `.env`, `*.db` or settings file; no API-key-like strings in `git log -p a549514..notebook-features`; every commit by WU Jinyu, with the Claude co-author lines.
  - **The founder's own notebook content taken out of the history.** Handoffs and two ADRs had quoted it when describing checks on his notebook: thread and note titles, answer lines, words searched, the subjects he studies, and the paper he added. Before the first push, every commit of the branch was rewritten (`git filter-branch --tree-filter` with a script of exact replacements) so no commit holds them; only those 14 lines in 10 docs changed, code and tests are identical. Counts (threads, messages, blocks) and timings were kept. The branch as it was before is kept locally as `backup/notebook-features-before-scrub`, and must not be pushed.
  - The README is now short; the milestones moved to `docs/status.md`.
- **Tried from the Claude session: refused.** The session's git proxy answered 403: `Hanskrrr/NoemaWeb` is not in the session's authorized repositories, so it gives no credential. Adding the repository needs the GitHub account linked to Claude (claude.ai Settings → Connectors). The bridge to the Mac cannot reach github.com either (no DNS for SSH, HTTPS blocked by its proxy).
- **How it is pushed instead: from the Mac, with the founder's SSH key** (the Mac's `origin` is `git@github.com:Hanskrrr/NoemaWeb.git`):

  ```sh
  cd ~/Code/CodeFactory/AgenticSys/NoemaLearningNote/NoemaWeb
  git status                      # clean, on notebook-features
  git log --oneline -1            # docs: push log …
  git push -u origin notebook-features
  ```

  Then, when ready, a pull request `notebook-features` → `main` on GitHub.
- **Result.** Waiting for the push from the Mac. When it is done, record here: the commit pushed, when, and by whom.
