// Runs in a worker thread: pdf.js reads one PDF and sends back each page's
// text items. Kept off the main thread so a large or broken file cannot hold
// up answers being streamed, and so it can be stopped after a time limit.

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import type { PdfPageText, PdfTextItem } from '@noema/core';

export interface PdfWorkerResult {
  ok: true;
  title: string | null;
  pages: PdfPageText[];
}
export interface PdfWorkerFailure {
  ok: false;
  /** 'password': the file is locked; 'broken': pdf.js could not read it; 'missing': pdf.js is not installed. */
  reason: 'password' | 'broken' | 'missing';
}

interface RawItem {
  str?: string;
  transform?: number[];
  width?: number;
}

async function read(data: Uint8Array): Promise<PdfWorkerResult | PdfWorkerFailure> {
  let pdfjs: typeof import('pdfjs-dist/legacy/build/pdf.mjs');
  let root: string;
  try {
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    root = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
  } catch {
    return { ok: false, reason: 'missing' };
  }
  const task = pdfjs.getDocument({
    data,
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
    return { ok: false, reason: err instanceof Error && err.name === 'PasswordException' ? 'password' : 'broken' };
  }
  try {
    const info = (await doc.getMetadata().catch(() => null))?.info as { Title?: unknown } | undefined;
    const pages: PdfPageText[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const view = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items: PdfTextItem[] = [];
      for (const raw of content.items as RawItem[]) {
        const t = raw.transform;
        if (typeof raw.str !== 'string' || !t) continue;
        // A glyph with no character (a bullet in some TeX fonts) is passed on as U+FFFC.
        const str = raw.str === '' ? ((raw.width ?? 0) > 0.5 ? '\ufffc' : '') : raw.str;
        if (str === '') continue;
        const [a = 0, b = 0, c = 0, d = 0, x = 0, y = 0] = t;
        // Upright text only: a margin stamp turned on its side is not part of the page's text.
        if (Math.abs(b) > 0.1 * Math.abs(a) || Math.abs(c) > 0.1 * Math.abs(d) || a <= 0 || d <= 0) continue;
        items.push({ str, x, y, width: raw.width ?? 0, size: Math.hypot(c, d) });
      }
      pages.push({ width: view.width, height: view.height, items });
      page.cleanup();
    }
    return { ok: true, title: typeof info?.Title === 'string' ? info.Title : null, pages };
  } catch {
    return { ok: false, reason: 'broken' };
  } finally {
    await task.destroy();
  }
}

const port = parentPort;
if (port) {
  read(workerData as Uint8Array).then(
    (result) => port.postMessage(result),
    () => port.postMessage({ ok: false, reason: 'broken' } satisfies PdfWorkerFailure),
  );
}
