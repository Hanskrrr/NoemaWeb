// A thin wrapper over Node's built-in SQLite (node:sqlite). One file, WAL
// mode, foreign keys on, numbered SQL migrations tracked in user_version.

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

export class Db {
  readonly sql: DatabaseSync;
  readonly path: string;
  private depth = 0;

  constructor(path: string) {
    this.path = path;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.sql = new DatabaseSync(path);
    this.sql.exec('PRAGMA foreign_keys = ON');
    this.sql.exec('PRAGMA busy_timeout = 5000');
    if (path !== ':memory:') {
      this.sql.exec('PRAGMA journal_mode = WAL');
      this.sql.exec('PRAGMA synchronous = NORMAL');
    }
  }

  get version(): number {
    const row = this.sql.prepare('PRAGMA user_version').get() as { user_version: number };
    return row.user_version;
  }

  /** Apply every migrations/NNN_*.sql above the current user_version, each in its own transaction. */
  migrate(dir: string = MIGRATIONS_DIR): number {
    const files = readdirSync(dir)
      .filter((f) => /^\d{3}_.+\.sql$/.test(f))
      .sort();
    let applied = 0;
    for (const file of files) {
      const n = Number(file.slice(0, 3));
      if (n <= this.version) continue;
      const sql = readFileSync(join(dir, file), 'utf8');
      this.tx(() => {
        this.sql.exec(sql);
        this.sql.exec(`PRAGMA user_version = ${n}`);
      });
      applied++;
    }
    return applied;
  }

  /** Run fn in one write transaction. Nested calls join the outer one. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.sql.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const result = fn();
      this.sql.exec('COMMIT');
      return result;
    } catch (err) {
      this.sql.exec('ROLLBACK');
      throw err;
    } finally {
      this.depth--;
    }
  }

  /** A consistent copy of the whole database, safe while the server runs. */
  backupTo(dest: string): void {
    mkdirSync(dirname(dest), { recursive: true });
    rmSync(dest, { force: true });
    this.sql.prepare('VACUUM INTO ?').run(dest);
  }

  close(): void {
    if (this.sql.isOpen) this.sql.close();
  }
}

/**
 * Keep one copy per day in backupDir, the newest `keep` of them.
 * Returns the file written, or null if today's copy already exists.
 */
export function dailyBackup(db: Db, backupDir: string, keep = 7, now = new Date()): string | null {
  const day = now.toISOString().slice(0, 10);
  const dest = join(backupDir, `noema-${day}.db`);
  try {
    if (statSync(dest).isFile()) return null;
  } catch {
    // no copy today yet
  }
  db.backupTo(dest);
  const copies = readdirSync(backupDir)
    .filter((f) => /^noema-\d{4}-\d{2}-\d{2}\.db$/.test(f))
    .sort();
  for (const old of copies.slice(0, Math.max(0, copies.length - keep))) rmSync(join(backupDir, old), { force: true });
  return dest;
}
