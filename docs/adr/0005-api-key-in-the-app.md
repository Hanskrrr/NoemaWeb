# 0005. The API key is entered in the app and kept out of the database

Date: 2026-11-05. Status: accepted.

## Context

Until now the key had to go into a `.env` file, and the app fell back to a fake model without one. The founder asked for the key to be entered in the web app and for the fake model to disappear from normal use.

## Decision

- With no key, the app opens on a **Connect a model** screen (DeepSeek preset, or any OpenAI-compatible base URL and model). Later changes go through **Model settings**, opened from the model name in the header.
- `PUT /api/settings/model` checks the settings with the provider before saving: `GET /models` first (free on most providers); if the model is not listed, or there is no list, a 16-token test answer. A key that does not work is not saved, and the reason comes back as a named error.
- The key is written to `data/settings.json` next to the database, with mode 0600, by write-then-rename. It is never stored in SQLite, so JSON exports and the daily backups never contain it. Responses only say whether a key is saved and show its last four characters.
- Precedence: settings saved in the app, then `.env`, then the defaults (`https://api.deepseek.com`, `deepseek-flash`). `DELETE /api/settings/model` forgets the saved settings.
- The default provider is the real one. `NOEMA_PROVIDER=fake` remains for automated tests only and never appears in the UI.
- No output cap is sent unless `NOEMA_MAX_OUTPUT_TOKENS` is set: DeepSeek's current models think by default, and a low cap could cut answers short.

## Consequences

- A new user needs only `pnpm install`, `pnpm dev` and a key.
- Anyone who can reach the local server can replace the key, which is the same trust boundary as the rest of the API (loopback only, Host and Origin checks, client header).
- The key sits in a plain file protected by file permissions, not the macOS Keychain.

## How to reverse

Store the key in the OS keychain (for example through a native module or a desktop shell) behind the same `ModelSettings` class.
