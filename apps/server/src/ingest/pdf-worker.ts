// Runs in a worker thread: pdf.js reads one PDF and sends back each page's
// text items. Kept off the main thread so a large or broken file cannot hold
// up answers being streamed, and so it can be stopped after a time limit.
// readPdfPages is also called directly when a worker cannot be started.
//
// Only text is read, so pdf.js is loaded without its native drawing package
// (@napi-rs/canvas): it would be loaded into the server for nothing, and on
// the founder's Mac reading failed in the server while it worked in a script.

import { createRequire, registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { type PdfjsTextItem, type PdfPageText, pdfPageText } from '@noema/core';

/**
 * What this worker posts, marked as ours: Node itself may post other messages
 * on a worker's port (under `node --watch`, Node 26 reports the modules a
 * worker loads), and they are not answers.
 */
export type PdfWorkerMessage = { noemaPdf: 'ready' } | { noemaPdf: 'done'; result: PdfWorkerResult | PdfWorkerFailure };

export interface PdfWorkerResult {
  ok: true;
  title: string | null;
  pages: PdfPageText[];
}
export interface PdfWorkerFailure {
  ok: false;
  /** 'password': the file is locked; 'broken': pdf.js could not read it; 'missing': pdf.js is not installed. */
  reason: 'password' | 'broken' | 'missing';
  /** What went wrong, for the log: an error's name and message, never the file's text. */
  detail?: string;
}

/** An error as one short line for the log. */
export function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}${'code' in err ? ` ${String(err.code)}` : ''}: ${err.message}`.slice(0, 300);
  return String(err).slice(0, 300);
}

/**
 * Enough of DOMMatrix for pdf.js to load: it builds one when it is imported,
 * and uses them only to draw pages.
 */
class TextOnlyMatrix {
  a = 1;
  b = 0;
  c = 0;
  d = 1;
  e = 0;
  f = 0;
  constructor(init?: number[]) {
    if (!Array.isArray(init) || init.length < 6) return;
    const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = init;
    Object.assign(this, { a, b, c, d, e, f });
  }
  multiplySelf(m: TextOnlyMatrix): this {
    const { a, b, c, d, e, f } = this;
    this.a = a * m.a + c * m.b;
    this.b = b * m.a + d * m.b;
    this.c = a * m.c + c * m.d;
    this.d = b * m.c + d * m.d;
    this.e = a * m.e + c * m.f + e;
    this.f = b * m.e + d * m.f + f;
    return this;
  }
  translateSelf(x = 0, y = 0): this {
    return this.multiplySelf(new TextOnlyMatrix([1, 0, 0, 1, x, y]));
  }
  scaleSelf(x = 1, y = x): this {
    return this.multiplySelf(new TextOnlyMatrix([x, 0, 0, y, 0, 0]));
  }
}

let prepared = false;

/** Load pdf.js for reading text: a stand-in for its native drawing package, and a DOMMatrix if there is none. */
function prepareForText(): void {
  if (prepared) return;
  prepared = true;
  const stub = new URL('./no-canvas.cjs', import.meta.url).href;
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier === '@napi-rs/canvas') return { url: stub, format: 'commonjs', shortCircuit: true };
      return next(specifier, context);
    },
  });
  const g = globalThis as Record<string, unknown>;
  g.DOMMatrix ??= TextOnlyMatrix;
  g.Path2D ??= class {};
}

export async function readPdfPages(data: Uint8Array): Promise<PdfWorkerResult | PdfWorkerFailure> {
  let pdfjs: typeof import('pdfjs-dist/legacy/build/pdf.mjs');
  let root: string;
  try {
    prepareForText();
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    root = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
  } catch (err) {
    return { ok: false, reason: 'missing', detail: describeError(err) };
  }
  const task = pdfjs.getDocument({
    // A copy: pdf.js takes the buffer it is given (it is detached afterwards).
    data: data.slice(),
    // Text only: no fonts installed, no system fonts, no forms. (pdf.js 6 has no eval to turn off.)
    disableFontFace: true,
    useSystemFonts: false,
    enableXfa: false,
    // Character maps for Chinese, Japanese and Korean fonts that do not carry their own.
    cMapUrl: join(root, 'cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: join(root, 'standard_fonts/'),
    verbosity: 0,
  });
  let doc: Awaited<typeof task.promise>;
  try {
    doc = await task.promise;
  } catch (err) {
    await task.destroy();
    const password = err instanceof Error && err.name === 'PasswordException';
    return { ok: false, reason: password ? 'password' : 'broken', detail: describeError(err) };
  }
  try {
    const info = (await doc.getMetadata().catch(() => null))?.info as { Title?: unknown } | undefined;
    const pages: PdfPageText[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const view = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      pages.push(pdfPageText(content.items as PdfjsTextItem[], view));
      page.cleanup();
    }
    return { ok: true, title: typeof info?.Title === 'string' ? info.Title : null, pages };
  } catch (err) {
    return { ok: false, reason: 'broken', detail: describeError(err) };
  } finally {
    await task.destroy();
  }
}

const port = parentPort;
if (port) {
  // Loaded and running: from here on a failure is the file's, not the worker's.
  port.postMessage({ noemaPdf: 'ready' } satisfies PdfWorkerMessage);
  readPdfPages(workerData as Uint8Array).then(
    (result) => port.postMessage({ noemaPdf: 'done', result } satisfies PdfWorkerMessage),
    (err) =>
      port.postMessage({
        noemaPdf: 'done',
        result: { ok: false, reason: 'broken', detail: describeError(err) },
      } satisfies PdfWorkerMessage),
  );
}
