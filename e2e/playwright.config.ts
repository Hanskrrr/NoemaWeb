import { defineConfig, devices } from '@playwright/test';
import { EMPTY_PORT, FAKE_PORT, FRESH_PORT } from './ports.ts';

// The e2e suite runs the real server serving the real built web app, and
// drives it in Chromium. It never calls a real model.
const start = 'node --disable-warning=ExperimentalWarning apps/server/src/main.ts';

function server(port: number, command: string, env: Record<string, string>) {
  return {
    command: process.env.E2E_SERVER_CMD ?? command,
    cwd: '..',
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      NOEMA_PORT: String(port),
      NOEMA_DB_PATH: ':memory:',
      NOEMA_WEB_DIST: process.env.E2E_WEB_DIST ?? 'apps/web/dist',
      NOEMA_LOG: 'warn',
      // Set explicitly so a developer's own .env can never leak into a test.
      NOEMA_LLM_BASE_URL: 'https://api.deepseek.com',
      NOEMA_LLM_MODEL: 'deepseek-flash',
      NOEMA_LLM_API_KEY: '',
      ...env,
    },
  };
}

export default defineConfig({
  testDir: '.',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${FAKE_PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    server(FAKE_PORT, `pnpm build && ${start}`, { NOEMA_PROVIDER: 'fake', NOEMA_FAKE_DELAY_MS: '4' }),
    server(FRESH_PORT, start, { NOEMA_PROVIDER: 'openai-compatible' }),
    server(EMPTY_PORT, start, { NOEMA_PROVIDER: 'fake', NOEMA_FAKE_DELAY_MS: '4' }),
  ],
});
