# Handoff 2026-11-05: connect a model in the app

## What changed

- **Connect a model.** With no key, the app opens on a setup screen: provider (DeepSeek preset, or any OpenAI-compatible base URL), model, API key. **Save and connect** checks the key with the provider first and saves only if it works. The model name in the header opens **Model settings** to change the model, replace the key or remove it. A failed answer caused by the key (`auth`, `quota`, `not_configured`) offers a button to open the settings.
- **No fake model in normal use.** The default provider is the real one. The fake stays for `pnpm test` and `pnpm e2e` only.
- **DeepSeek's current names.** The default model is `deepseek-flash` (DeepSeek-V4.1-Flash); `deepseek-v4-pro` is suggested too. `deepseek-chat` is no longer listed in DeepSeek's docs.
- **No forced output cap.** `max_tokens` is sent only if `NOEMA_MAX_OUTPUT_TOKENS` is set (DeepSeek's models think by default).
- **Key storage.** `data/settings.json`, mode 0600, never in SQLite, exports, backups, logs or responses (ADR 0005).
- **Tests.** e2e now runs two servers: the fake-model one, and one with no model for the first-run flow against a stand-in provider. The stop test waits for some text before pressing Stop (it was timing-dependent and failed on a fast Mac).
- The lockfile and the founder's Biome formatting run are committed in the sandbox copy; on the Mac they are still uncommitted.

## Verified

| Check                               | Result                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node --test` (core, server, web)   | 83 pass, including 9 new settings tests against a stand-in provider: wrong key refused and not saved; working key saved with mode 0600 and never echoed; key absent from the export; a model not in the list is tried directly; a provider without `/models`; unreachable provider; restart keeps settings; remove; damaged file ignored |
| Playwright                          | 11 pass, including first run: wrong key, then right key, ask, see the answer, settings show only `sk-…6789`, remove the key                                                                                                                                                                                                              |
| `tsc`                               | core, server, scripts and e2e in the sandbox; all four on the Mac's real dependencies (see below)                                                                                                                                                                                                                                        |
| Visual                              | Connect screen in light at desktop width and dark at phone width                                                                                                                                                                                                                                                                         |
| Real DeepSeek, on the founder's Mac | Key saved through the app; 4 answers from `deepseek-flash`, all done on the first attempt, first token after 1.8–7.1 s. The prompt cache hit grew from 0 to 1,664 of 3,048 prompt tokens by the fourth turn, so the stable-prefix ordering works                                                                                         |

## Not verified

- Biome on the new code: run `pnpm format` before committing.

## Next

Finish M1 (regenerate as a revision, thread list, code highlighting), then M2 (Ask in a branch).
