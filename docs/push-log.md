# Push log

How each push to GitHub (`Hanskrrr/NoemaWeb`) was made, so the next one can be made the same way. Newest first. Add an entry for every push: what, the checks before it, how, and the result.

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
- **Result.** Waiting for the push from the Mac. When it is done, record here: the commit pushed, when, and by whom.
