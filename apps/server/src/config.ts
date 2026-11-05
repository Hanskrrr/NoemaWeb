import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** The repository root. Default paths are relative to it, wherever the server is started from. */
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const Env = z.object({
  NOEMA_HOST: z.string().default('127.0.0.1'),
  NOEMA_PORT: z.coerce.number().int().min(0).max(65535).default(8787),
  NOEMA_DB_PATH: z.string().default(join(REPO_ROOT, 'data', 'noema.db')),
  NOEMA_BACKUP_DIR: z.string().optional(),
  NOEMA_SETTINGS_PATH: z.string().optional(),
  // `fake` is for automated tests only: fixed answers, no network, no cost.
  NOEMA_PROVIDER: z.enum(['fake', 'openai-compatible']).default('openai-compatible'),
  NOEMA_LLM_BASE_URL: z.string().url().default('https://api.deepseek.com'),
  NOEMA_LLM_API_KEY: z.string().default(''),
  NOEMA_LLM_MODEL: z.string().min(1).default('deepseek-flash'),
  NOEMA_CONTEXT_BUDGET: z.coerce.number().int().positive().default(48_000),
  // Unset: the provider's own default. Thinking models spend part of it on reasoning.
  NOEMA_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().optional(),
  NOEMA_WEB_DIST: z.string().optional(),
  NOEMA_FAKE_DELAY_MS: z.coerce.number().int().nonnegative().default(15),
  NOEMA_LOG: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
});

export interface Config {
  host: string;
  port: number;
  dbPath: string;
  backupDir: string | null;
  /** Model settings saved from the app, including the API key. Null keeps them in memory only. */
  settingsPath: string | null;
  provider: 'fake' | 'openai-compatible';
  llm: { baseUrl: string; apiKey: string; model: string };
  contextBudgetTokens: number;
  maxOutputTokens: number | null;
  webDist: string | null;
  fakeDelayMs: number;
  log: 'debug' | 'info' | 'warn' | 'error' | 'silent';
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Treat empty values in .env as unset.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([k, v]) => k.startsWith('NOEMA_') && v !== ''));
  const parsed = Env.safeParse(cleaned);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new ConfigError(`invalid configuration:\n${lines.join('\n')}`);
  }
  const e = parsed.data;
  if (!LOOPBACK.has(e.NOEMA_HOST)) {
    // The server has no login. Listening beyond this machine would expose the notebook.
    throw new ConfigError(`NOEMA_HOST must be a loopback address (127.0.0.1, localhost or ::1), got ${e.NOEMA_HOST}`);
  }
  const dbPath = e.NOEMA_DB_PATH;
  return {
    host: e.NOEMA_HOST,
    port: e.NOEMA_PORT,
    dbPath,
    backupDir: dbPath === ':memory:' ? null : (e.NOEMA_BACKUP_DIR ?? join(REPO_ROOT, 'data', 'backups')),
    settingsPath: dbPath === ':memory:' ? null : (e.NOEMA_SETTINGS_PATH ?? join(dirname(dbPath), 'settings.json')),
    provider: e.NOEMA_PROVIDER,
    llm: { baseUrl: e.NOEMA_LLM_BASE_URL, apiKey: e.NOEMA_LLM_API_KEY, model: e.NOEMA_LLM_MODEL },
    contextBudgetTokens: e.NOEMA_CONTEXT_BUDGET,
    maxOutputTokens: e.NOEMA_MAX_OUTPUT_TOKENS ?? null,
    webDist: e.NOEMA_WEB_DIST ?? join(REPO_ROOT, 'apps', 'web', 'dist'),
    fakeDelayMs: e.NOEMA_FAKE_DELAY_MS,
    log: e.NOEMA_LOG,
  };
}
