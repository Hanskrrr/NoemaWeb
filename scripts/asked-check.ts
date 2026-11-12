// `pnpm asked:check [N]`: replay the notebook's questions, oldest first, and
// print which ones "asked before" would have flagged: by words, and by the
// connected model reading for meaning. For judging and tuning the reminder
// on your own notebook. It reads the notebook and writes nothing; it makes
// one small model call per question (the last N, or all). What it prints is
// your own questions: keep the output out of the repository.

import { join } from 'node:path';
import { askedBefore } from '../packages/core/src/index.ts';
import { AskedJudge } from '../apps/server/src/chat/asked.ts';
import { loadConfig, REPO_ROOT } from '../apps/server/src/config.ts';
import { FakeProvider } from '../apps/server/src/llm/fake.ts';
import { ModelSettings } from '../apps/server/src/llm/settings.ts';
import { createLogger } from '../apps/server/src/log.ts';
import { Db } from '../apps/server/src/store/db.ts';
import { Repo } from '../apps/server/src/store/repo.ts';

try {
  process.loadEnvFile(join(REPO_ROOT, '.env'));
} catch {
  // no .env
}
const config = loadConfig();
const log = createLogger('warn');
const db = new Db(config.dbPath);
const repo = new Repo(db);
const models = new ModelSettings({
  env: { provider: config.provider, ...config.llm },
  filePath: config.settingsPath,
  fake: () => new FakeProvider({ delayMs: 0 }),
  log,
});
const judge = new AskedJudge({ repo, models, log });
const view = models.view();
const last = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : Number.POSITIVE_INFINITY;

const short = (text: string | null | undefined, max = 60) => {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

const out = (line: string) => process.stdout.write(`${line}\n`);
out(`Notebook: ${config.dbPath}`);
out(view.configured ? `Model: ${view.model}` : 'No model connected: only words are compared.');

let flagged = 0;
let checked = 0;
for (const notebook of repo.listNotebooks()) {
  const all = repo.askedCandidates(notebook.id);
  for (const [i, q] of all.entries()) {
    if (i < all.length - last || !q.question.trim()) continue;
    const lineage = new Set(repo.lineage(q.threadId));
    const earlier = all.slice(0, i).filter((c) => !lineage.has(c.threadId));
    if (earlier.length === 0) continue;
    checked++;
    const words = askedBefore({ text: q.question, passage: q.passage }, earlier);
    let meaning: Awaited<ReturnType<AskedJudge['among']>> = null;
    if (view.configured) {
      try {
        meaning = await judge.among(earlier, { text: q.question, passage: q.passage });
      } catch (err) {
        out(`  (the model could not be asked: ${err instanceof Error ? err.message : String(err)})`);
      }
    }
    const found = [
      ...words.map((m) => ({ id: m.id, how: `words, ${m.strength}` })),
      ...(meaning?.hits ?? []).map((h) => ({ id: h.messageId, how: `meaning, ${h.strength}` })),
    ];
    if (found.length === 0) continue;
    flagged++;
    out('');
    out(`${q.askedAt.slice(0, 10)}  "${short(q.question)}"${q.passage ? `  on "${short(q.passage, 40)}"` : ''}  (in ${short(q.title, 30) || 'Untitled'})`);
    for (const f of found) {
      const c = all.find((x) => x.id === f.id);
      out(`    ${f.how}: "${short(c?.question)}"${c?.passage ? `  on "${short(c.passage, 40)}"` : ''}  (in ${short(c?.title, 30) || 'Untitled'})`);
    }
  }
}
out('');
out(`${checked} questions checked against those before them; ${flagged} would have had a reminder.`);
db.close();
