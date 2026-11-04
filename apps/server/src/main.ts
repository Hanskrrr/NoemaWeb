// Entry point: `pnpm start` (built web app) or `pnpm dev` (with Vite).

import { join, resolve } from 'node:path';
import { createApp, VERSION } from './app.ts';
import { ConfigError, loadConfig, REPO_ROOT } from './config.ts';
import { FakeProvider } from './llm/fake.ts';
import { OpenAICompatibleProvider } from './llm/openai-compatible.ts';
import type { ModelProvider } from './llm/provider.ts';
import { createLogger } from './log.ts';
import { Db, dailyBackup } from './store/db.ts';
import { Repo } from './store/repo.ts';

try {
  // Variables already set in the environment win over the file.
  process.loadEnvFile(join(REPO_ROOT, '.env'));
} catch {
  // no .env: defaults and the real environment apply
}

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
  throw err;
}

const log = createLogger(config.log);
const db = new Db(config.dbPath);
const applied = db.migrate();
const repo = new Repo(db);
const interrupted = repo.interruptLive();
repo.ensureDefaultNotebook();

let backupTimer: NodeJS.Timeout | null = null;
if (config.backupDir) {
  const backupDir = config.backupDir;
  const backup = () => {
    try {
      const file = dailyBackup(db, backupDir);
      if (file) log.info('backup written', { file });
    } catch (err) {
      log.warn('backup failed', { err });
    }
  };
  backup();
  backupTimer = setInterval(backup, 60 * 60 * 1000);
  backupTimer.unref();
}

const provider: ModelProvider =
  config.provider === 'fake'
    ? new FakeProvider({ delayMs: config.fakeDelayMs })
    : new OpenAICompatibleProvider(config.llm);

const webDist = config.webDist ? resolve(config.webDist) : null;
const app = createApp({ repo, provider, config: { ...config, webDist }, log });

app.server.listen(config.port, config.host, () => {
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  log.info('noema server listening', {
    url: `http://${config.host.includes(':') ? `[${config.host}]` : config.host}:${port}`,
    version: VERSION,
    db: config.dbPath,
    migrationsApplied: applied,
    interruptedAtBoot: interrupted,
    provider: provider.name,
    model: provider.model,
    configured: provider.configured,
    webDist,
  });
  if (!provider.configured) log.warn('the model provider is not configured; answers will fail until NOEMA_LLM_API_KEY is set');
});

let closing = false;
const shutdown = async (signal: string) => {
  if (closing) return;
  closing = true;
  log.info('shutting down', { signal, live: app.generations.size });
  if (backupTimer) clearInterval(backupTimer);
  const force = setTimeout(() => process.exit(1), 5000);
  force.unref();
  await app.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
