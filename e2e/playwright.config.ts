import { defineConfig, devices } from '@playwright/test';

// The e2e suite runs the real server (fake model, in-memory store) serving
// the real built web app, and drives it in Chromium.
const PORT = 8799;

export default defineConfig({
  testDir: '.',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command:
      process.env.E2E_SERVER_CMD ??
      'pnpm build && node --disable-warning=ExperimentalWarning apps/server/src/main.ts',
    cwd: '..',
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      NOEMA_PORT: String(PORT),
      NOEMA_DB_PATH: ':memory:',
      NOEMA_PROVIDER: 'fake',
      NOEMA_FAKE_DELAY_MS: '4',
      NOEMA_WEB_DIST: process.env.E2E_WEB_DIST ?? 'apps/web/dist',
      NOEMA_LOG: 'warn',
    },
  },
});
