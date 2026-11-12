// `pnpm pdf:check <file.pdf> [...]`: read PDFs the way Noema does and print
// what came out, in counts, or why it could not be read. For finding out why
// a PDF fails on this computer. It writes nothing. Counts only, so the output
// can be pasted into a bug report.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { sourceHeadings } from '../packages/core/src/index.ts';
import { PdfProblem, readPdf } from '../apps/server/src/ingest/pdf.ts';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.log('usage: pnpm pdf:check <file.pdf> [more.pdf ...]');
  process.exit(1);
}
console.log(`node ${process.version} on ${process.platform}-${process.arch}`);
let failed = 0;
for (const file of files) {
  const started = performance.now();
  const notes: string[] = [];
  try {
    const bytes = new Uint8Array(readFileSync(file));
    const r = await readPdf(bytes, { onFallback: (d) => notes.push(`read without a worker thread (${d})`) });
    const headings = sourceHeadings(r.markdown).filter((h) => h.level > 2).length;
    const items = (r.markdown.match(/^- /gm) ?? []).length;
    console.log(
      `${basename(file)}: ${r.pages} pages (${r.emptyPages} without text), ${r.markdown.length} characters, ` +
        `${headings} headings, ${items} list items, title ${r.title ? `${r.title.length} characters` : 'none'}` +
        `${r.truncated ? ', cut short' : ''}, ${Math.round(performance.now() - started)} ms`,
    );
  } catch (err) {
    failed++;
    if (err instanceof PdfProblem) console.log(`${basename(file)}: not read: ${err.message}${err.detail ? ` [${err.detail}]` : ''}`);
    else console.log(`${basename(file)}: not read: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
  }
  for (const n of notes) console.log(`  note: ${n}`);
}
process.exit(failed > 0 ? 1 : 0);
