// Folders on the learner's computer (ADR 0025). A folder is linked by its
// path; Noema lists it, reads its files in place and, when asked, writes
// into it. Every path is resolved inside the folder (links that lead out are
// refused), hidden and generated folders are not listed, and a write keeps
// what the file said before, so it can be undone.

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { cleanFilePath, type FileEntry, type Folder, fileMarkdown, fileName, type Source, ulid } from '@noema/core';
import { readPdf, PDF_EXTRACTOR, PdfProblem, pdfToRaw, looksLikePdf, MAX_PDF_BYTES } from '../ingest/pdf.ts';
import type { Logger } from '../log.ts';
import type { Repo } from '../store/repo.ts';

/** Largest text file read. */
export const MAX_TEXT_BYTES = 2_000_000;
/** Not listed, not searched: version control, dependencies, builds, caches. */
const SKIP = new Set([
  'node_modules', '.git', '.hg', '.svn', '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache', '.next',
  'dist', 'build', 'target', '.cache', '.idea', '.vscode', '.DS_Store', '.ipynb_checkpoints', 'coverage',
]);
const MAX_ENTRIES = 2000;
const FIND_FILES = 4000;
const FIND_HITS = 40;

/** Something the learner can act on: a sentence (and, for the log, what lay under it). */
export class FileProblem extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'FileProblem';
    this.status = status;
  }
}

type Read = { kind: 'text'; text: string; hash: string; bytes: number } | { kind: 'pdf'; data: Uint8Array; hash: string; bytes: number };

const hashOf = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');

/** A folder's path as typed: ~ is home; it must be absolute. */
export function folderPath(input: string): string {
  const t = input.trim().replace(/^["']|["']$/g, '');
  const p = t === '~' ? homedir() : t.startsWith('~/') ? join(homedir(), t.slice(2)) : t;
  if (!isAbsolute(p)) throw new FileProblem('Give the whole path of the folder, starting with / or ~ (in Finder, ⌥⌘C copies it).');
  return resolve(p);
}

function isText(data: Uint8Array): boolean {
  const head = data.subarray(0, 8000);
  return !head.includes(0);
}

export class Folders {
  private readonly repo: Repo;
  private readonly log: Logger;

  constructor(deps: { repo: Repo; log: Logger }) {
    this.repo = deps.repo;
    this.log = deps.log;
  }

  /** Link a folder to the notebook. */
  async add(notebookId: string, id: string, input: string): Promise<Folder> {
    const wanted = folderPath(input);
    let real: string;
    try {
      real = await realpath(wanted);
      if (!(await stat(real)).isDirectory()) throw new FileProblem('That is a file, not a folder.');
    } catch (err) {
      if (err instanceof FileProblem) throw err;
      throw new FileProblem('There is no folder at that path.');
    }
    if (real === sep || real === homedir()) throw new FileProblem('Choose a folder inside your home folder, not all of it.');
    const f = this.repo.addFolder(notebookId, id, real, basename(real) || real);
    return this.view(f);
  }

  async list(notebookId: string): Promise<Folder[]> {
    return Promise.all(this.repo.listFolders(notebookId).map((f) => this.view(f)));
  }

  private async view(f: { id: string; name: string; path: string }): Promise<Folder> {
    const missing = await stat(f.path).then((s) => !s.isDirectory(), () => true);
    return { id: f.id, name: f.name, path: f.path, missing };
  }

  private folder(id: string) {
    const f = this.repo.getFolder(id);
    if (!f) throw new FileProblem('That folder is not linked.', 404);
    return f;
  }

  /** A path inside a folder, as a path on disk; refused if it (or a link in it) leads outside. */
  private async inside(folderId: string, rel: string, opts: { mayNotExist?: boolean } = {}): Promise<{ abs: string; rel: string; root: string }> {
    const f = this.folder(folderId);
    const clean = cleanFilePath(rel);
    if (!clean) throw new FileProblem('That path is not inside the folder.');
    let root: string;
    try {
      root = await realpath(f.path);
    } catch {
      throw new FileProblem(`The folder “${f.name}” is not there any more (moved, renamed, or a drive not connected).`, 404);
    }
    const joined = join(root, ...clean.split('/'));
    let real: string;
    try {
      real = await realpath(joined);
    } catch {
      if (!opts.mayNotExist) throw new FileProblem(`There is no “${clean}” in “${f.name}”.`, 404);
      // A new file: its nearest existing folder must be inside.
      let parent = dirname(joined);
      for (;;) {
        try {
          parent = await realpath(parent);
          break;
        } catch {
          parent = dirname(parent);
        }
      }
      if (parent !== root && !parent.startsWith(root + sep)) throw new FileProblem('That path is not inside the folder.');
      return { abs: joined, rel: clean, root };
    }
    if (real !== root && !real.startsWith(root + sep)) throw new FileProblem('That path leads outside the folder.');
    return { abs: real, rel: clean, root };
  }

  /** What is in a folder (or a folder inside it): folders first, then files, by name. */
  async tree(folderId: string, dir: string): Promise<FileEntry[]> {
    const f = this.folder(folderId);
    const at = dir.trim() === '' ? { abs: await realpath(f.path).catch(() => f.path), rel: '' } : await this.inside(folderId, dir);
    let names: import('node:fs').Dirent[];
    try {
      names = await readdir(at.abs, { withFileTypes: true });
    } catch {
      throw new FileProblem('That folder cannot be read.', 404);
    }
    const opened = this.repo.openedFiles(folderId);
    const out: FileEntry[] = [];
    for (const d of names) {
      if (d.name.startsWith('.') || SKIP.has(d.name)) continue;
      const path = at.rel ? `${at.rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        out.push({ name: d.name, path, kind: 'dir', size: null, readable: false, sourceId: null });
      } else if (d.isFile() || d.isSymbolicLink()) {
        const s = await stat(join(at.abs, d.name)).catch(() => null);
        if (!s || !s.isFile()) continue;
        out.push({ name: d.name, path, kind: 'file', size: s.size, readable: readableName(d.name, s.size), sourceId: opened.get(path) ?? null });
      }
      if (out.length >= MAX_ENTRIES) break;
    }
    return out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.kind === 'dir' ? -1 : 1));
  }

  /** A file's bytes: text, or a PDF; refused if too large or not text. */
  async read(folderId: string, rel: string): Promise<Read & { rel: string }> {
    const at = await this.inside(folderId, rel);
    const s = await stat(at.abs);
    if (!s.isFile()) throw new FileProblem('That is a folder, not a file.');
    const data = new Uint8Array(await readFile(at.abs));
    if (looksLikePdf(data)) {
      if (data.byteLength > MAX_PDF_BYTES) throw new FileProblem(`That PDF is larger than ${MAX_PDF_BYTES / 1e6} MB.`);
      return { kind: 'pdf', data, hash: hashOf(data), bytes: data.byteLength, rel: at.rel };
    }
    if (data.byteLength > MAX_TEXT_BYTES) throw new FileProblem(`That file is larger than ${MAX_TEXT_BYTES / 1e6} MB.`);
    if (!isText(data)) throw new FileProblem('That file is not text (a picture, an archive or a program?): it cannot be read here.');
    return { kind: 'text', text: new TextDecoder().decode(data), hash: hashOf(data), bytes: data.byteLength, rel: at.rel };
  }

  /**
   * Open a file as a source: made the first time; read again (a new version)
   * when the file changed on disk since; brought back from the Trash.
   */
  async open(folderId: string, rel: string): Promise<Source> {
    const f = this.folder(folderId);
    const file = await this.read(folderId, rel);
    let existing = this.repo.sourceOfFile(folderId, file.rel);
    if (existing?.deletedAt) existing = this.repo.restoreSource(existing.id);
    if (existing && this.repo.latestFileHash(existing.id) === file.hash) return existing;
    const version = await this.version(file);
    if (existing) {
      const { source, changed } = this.repo.addSourceVersion(existing.id, version);
      if (!changed) this.repo.setLatestFileHash(source.id, file.hash);
      return this.repo.getSource(source.id) as Source;
    }
    return this.repo.createFileSource(ulid(), f.notebookId, { folderId, path: file.rel }, {
      title: fileName(file.rel),
      version,
    });
  }

  private async version(file: Read & { rel: string }) {
    if (file.kind === 'text') {
      const content = fileMarkdown(file.rel, file.text);
      if (!content.trim() || content.replace(/`/g, '').trim() === '') throw new FileProblem('That file is empty.');
      return { content, origin: 'file' as const, fetchedUrl: null, raw: null, extractor: 'file-text-1', fileName: fileName(file.rel), fileHash: file.hash };
    }
    try {
      const pdf = await readPdf(file.data, { onFallback: (detail) => this.log.warn('pdf read without a worker thread', { detail }) });
      return {
        content: pdf.markdown,
        origin: 'file' as const,
        fetchedUrl: null,
        raw: pdfToRaw(file.data),
        extractor: PDF_EXTRACTOR,
        mediaType: 'application/pdf',
        fileName: fileName(file.rel),
        pages: pdf.pages,
        fileHash: file.hash,
      };
    } catch (err) {
      if (err instanceof PdfProblem) {
        this.log.warn('pdf not read', { reason: err.message, detail: err.detail, bytes: file.bytes });
        throw new FileProblem(`That PDF could not be read: ${err.message}.`);
      }
      throw err;
    }
  }

  /**
   * Write a text file (a new one, or over one), keeping what it said before.
   * `expectHash`: refused if the file is not what was read (it changed on disk since).
   * Returns the backup's id, to undo it.
   */
  async write(folderId: string, rel: string, content: string, opts: { expectHash?: string | null; mustBeNew?: boolean } = {}): Promise<string> {
    const at = await this.inside(folderId, rel, { mayNotExist: true });
    let before: string | null = null;
    const current = await readFile(at.abs).then((b) => new Uint8Array(b), () => null);
    if (current) {
      if (opts.mustBeNew) throw new FileProblem(`There is already a file “${at.rel}”.`);
      if (!isText(current) || looksLikePdf(current)) throw new FileProblem('That file is not text: Noema writes only text files.');
      if (opts.expectHash && hashOf(current) !== opts.expectHash) {
        throw new FileProblem('The file changed on disk since it was read: open it again, then make the change.', 409);
      }
      before = new TextDecoder().decode(current);
    }
    await mkdir(dirname(at.abs), { recursive: true });
    // Written beside it, then moved over it: a reader never sees half a file.
    const tmp = join(dirname(at.abs), `.${basename(at.abs)}.noema-${process.pid}.tmp`);
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, at.abs);
    const id = ulid();
    this.repo.addFileBackup({ id, folderId, path: at.rel, before, afterHash: hashOf(content) });
    this.log.info('file written', { folderId, bytes: Buffer.byteLength(content), created: before === null });
    return id;
  }

  /** Undo a write: the file back as it was (removed, if it was new), unless it changed since. */
  async undo(backupId: string): Promise<{ folderId: string; path: string }> {
    const b = this.repo.fileBackup(backupId);
    if (!b) throw new FileProblem('There is nothing to undo.', 404);
    const at = await this.inside(b.folderId, b.path, { mayNotExist: true });
    const now = await readFile(at.abs).then((x) => new Uint8Array(x), () => null);
    if (now && hashOf(now) !== b.afterHash) throw new FileProblem('The file changed since Noema wrote it, so it was left as it is.', 409);
    if (b.before === null) {
      if (now) await unlink(at.abs);
    } else {
      await writeFile(at.abs, b.before, 'utf8');
    }
    return { folderId: b.folderId, path: b.path };
  }

  /** Lines of text files that hold the words (all of them, any case), in the folders given. */
  async find(folderIds: string[], query: string): Promise<Array<{ folderId: string; path: string; line: number; text: string }>> {
    const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) return [];
    const hits: Array<{ folderId: string; path: string; line: number; text: string }> = [];
    let seen = 0;
    for (const folderId of folderIds) {
      const f = this.repo.getFolder(folderId);
      if (!f) continue;
      const root = await realpath(f.path).catch(() => null);
      if (!root) continue;
      const walk = async (dir: string): Promise<void> => {
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const d of entries) {
          if (hits.length >= FIND_HITS || seen >= FIND_FILES) return;
          if (d.name.startsWith('.') || SKIP.has(d.name)) continue;
          const abs = join(dir, d.name);
          if (d.isDirectory()) {
            await walk(abs);
            continue;
          }
          if (!d.isFile()) continue;
          seen++;
          const s = await stat(abs).catch(() => null);
          if (!s || s.size > 1_000_000) continue;
          const data = new Uint8Array(await readFile(abs).catch(() => Buffer.alloc(0)));
          if (!isText(data) || looksLikePdf(data)) continue;
          const rel = relative(root, abs).split(sep).join('/');
          const nameHit = words.every((w) => rel.toLowerCase().includes(w));
          const lines = new TextDecoder().decode(data).split('\n');
          let found = false;
          for (let i = 0; i < lines.length && hits.length < FIND_HITS; i++) {
            const l = (lines[i] as string).toLowerCase();
            if (words.every((w) => l.includes(w))) {
              hits.push({ folderId, path: rel, line: i + 1, text: (lines[i] as string).trim().slice(0, 200) });
              found = true;
            }
          }
          if (!found && nameHit) hits.push({ folderId, path: rel, line: 0, text: '' });
        }
      };
      await walk(root);
    }
    return hits;
  }
}

/** Opened in Noema by its name: text of any kind and PDFs; not pictures, media, archives or programs. */
function readableName(name: string, size: number): boolean {
  if (/\.pdf$/i.test(name)) return size <= MAX_PDF_BYTES;
  if (/\.(png|jpe?g|gif|webp|heic|bmp|tiff?|ico|icns|mp[34]|mov|avi|mkv|wav|flac|m4a|zip|gz|tgz|bz2|xz|7z|rar|dmg|pkg|exe|dll|so|dylib|o|a|class|jar|pyc|woff2?|ttf|otf|sqlite|db|bin|psd|key|pages|numbers|docx?|xlsx?|pptx?)$/i.test(name)) {
    return false;
  }
  return size <= MAX_TEXT_BYTES;
}
