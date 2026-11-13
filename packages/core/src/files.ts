// Files of a linked folder as sources (ADR 0025): a Markdown file is read as
// it is; any other text (code, notes, data) as one code block in its
// language, so it shows as written and can be selected and asked about.

const LANGUAGES: Record<string, string> = {
  ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js', json: 'json', py: 'python', ipynb: 'json',
  rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp',
  cs: 'csharp', swift: 'swift', m: 'matlab', r: 'r', jl: 'julia', scala: 'scala', sh: 'bash', zsh: 'bash', bash: 'bash',
  sql: 'sql', html: 'html', css: 'css', scss: 'scss', xml: 'xml', yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini',
  tex: 'latex', bib: 'bibtex', cu: 'cuda', lua: 'lua', php: 'php', dart: 'dart', vue: 'vue', svelte: 'svelte', csv: 'csv',
};

/** Whether a file is read as Markdown (as it is), by its name. */
export function isMarkdownFile(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path);
}

/** The last part of a path ("notes/week4.md" → "week4.md"). */
export function fileName(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path;
}

/** A file's text as the Markdown a source shows: Markdown as it is, anything else in a code block. */
export function fileMarkdown(path: string, text: string): string {
  const body = text.replace(/\r\n?/g, '\n');
  if (isMarkdownFile(path)) return body;
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? '';
  const lang = LANGUAGES[ext] ?? '';
  // A fence longer than any run of backticks in the text.
  const longest = Math.max(2, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${lang}\n${body.replace(/\n$/, '')}\n${fence}`;
}

/**
 * A path inside a folder as given (by the learner, a link, the Assistant):
 * parts joined with /, no leading slash, no "." or ".." parts, no empty
 * parts; null if it would leave the folder or is empty.
 */
export function cleanFilePath(path: string): string | null {
  const parts = path.replace(/\\/g, '/').split('/').filter((p) => p !== '' && p !== '.');
  if (parts.length === 0 || parts.some((p) => p === '..' || p.includes('\0'))) return null;
  return parts.join('/');
}

/** A note as a Markdown file: its title as a heading, then its blocks; citation labels go (they mean nothing outside the note). */
export function noteFile(title: string, blocks: string[]): string {
  const body = blocks
    .map((b) => b.replace(/\s*\[E\d{1,4}\]/g, '').trim())
    .filter(Boolean)
    .join('\n\n');
  const head = body.startsWith('# ') ? '' : `# ${title || 'Untitled'}\n\n`;
  return `${head}${body}\n`;
}
