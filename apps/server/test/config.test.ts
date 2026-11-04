import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, loadConfig, REPO_ROOT } from '../src/config.ts';

test('defaults: loopback, fake model, data under the repository root', () => {
  const c = loadConfig({});
  assert.equal(c.host, '127.0.0.1');
  assert.equal(c.port, 8787);
  assert.equal(c.provider, 'fake');
  assert.ok(c.dbPath.startsWith(REPO_ROOT));
  assert.ok(c.backupDir?.startsWith(REPO_ROOT));
});

test('empty values count as unset', () => {
  const c = loadConfig({ NOEMA_PORT: '', NOEMA_LLM_API_KEY: '' });
  assert.equal(c.port, 8787);
  assert.equal(c.llm.apiKey, '');
});

test('listening beyond this machine is refused', () => {
  assert.throws(() => loadConfig({ NOEMA_HOST: '0.0.0.0' }), ConfigError);
});

test('bad values are reported by name', () => {
  assert.throws(
    () => loadConfig({ NOEMA_PROVIDER: 'openai', NOEMA_PORT: 'eighty' }),
    (e: unknown) => e instanceof ConfigError && /NOEMA_PROVIDER/.test(e.message) && /NOEMA_PORT/.test(e.message),
  );
});

test('an in-memory store has no backups', () => {
  assert.equal(loadConfig({ NOEMA_DB_PATH: ':memory:', NOEMA_BACKUP_DIR: '/tmp/x' }).backupDir, null);
});
