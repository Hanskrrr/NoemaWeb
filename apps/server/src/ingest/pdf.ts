// Reading a PDF: pdf.js finds the text of each page (in a worker thread, with
// a time limit), core's pdfToMarkdown makes it Markdown. The file itself is
// kept with the version (base64, in `raw`), so it can be opened at a page and
// read again by a later reader without the network.

import { Worker } from 'node:worker_threads';
import { type PdfReading, pdfToMarkdown } from '@noema/core';
import { describeError, type PdfWorkerFailure, type PdfWorkerResult, readPdfPages } from './pdf-worker.ts';

// 1: lines, paragraphs, headings, lists and page headings from pdf.js 6 text items.
export const PDF_EXTRACTOR = 'noema-pdf-1';

/** Largest PDF read, from a file or an address. */
export const MAX_PDF_BYTES = 50_000_000;

const WORKER = new URL('./pdf-worker.ts', import.meta.url);

export class PdfProblem extends Error {
  /** What went wrong underneath, for the log (an error's name and message). */
  readonly detail: string | undefined;
  constructor(message: string, detail?: string) {
    super(message);
    this.name = 'PdfProblem';
    this.detail = detail;
  }
}

/** Does it start like a PDF? (Within the first kilobyte, as readers allow.) */
export function looksLikePdf(bytes: Uint8Array): boolean {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  return head.includes('%PDF-');
}

export interface ReadPdfOptions {
  timeoutMs?: number;
  /** Told when the worker could not be started and the PDF was read on the main thread instead. */
  onFallback?: (detail: string) => void;
  /** The worker's module (tests point it somewhere that does not load). */
  worker?: URL;
}

type Outcome = PdfWorkerResult | PdfWorkerFailure | 'timeout' | { started: false; detail: string };

/** pdf.js in a worker thread, stopped after `timeoutMs`. */
function inWorker(bytes: Uint8Array, url: URL, timeoutMs: number): Promise<Outcome> {
  return new Promise<Outcome>((resolve) => {
    let worker: Worker;
    try {
      // A copy: the worker owns its bytes.
      worker = new Worker(url, { workerData: bytes.slice(), resourceLimits: { maxOldGenerationSizeMb: 2048 } });
    } catch (err) {
      resolve({ started: false, detail: describeError(err) });
      return;
    }
    let answered = false;
    let ready = false;
    const finish = (outcome: Outcome) => {
      if (answered) return;
      answered = true;
      clearTimeout(timer);
      resolve(outcome);
      void worker.terminate();
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    worker.on('message', (m: PdfWorkerResult | PdfWorkerFailure | { ready: true }) => {
      if ('ready' in m) ready = true;
      else finish(m);
    });
    // Everything in the worker is caught: an error before it said it was ready
    // means it could not load here; after, the file broke it (or it ran out of memory).
    const failed = (detail: string) =>
      finish(ready ? { ok: false, reason: 'broken', detail } : { started: false, detail });
    worker.once('error', (err) => failed(describeError(err)));
    worker.once('exit', (code) => failed(`the worker stopped (exit code ${code})`));
  });
}

/**
 * The text of a PDF as Markdown. Throws PdfProblem with a reason a learner
 * can read: not a PDF, locked, unreadable, too slow, or no text at all. If a
 * worker thread cannot be started here, the PDF is read on the main thread.
 */
export async function readPdf(bytes: Uint8Array, opts: ReadPdfOptions = {}): Promise<PdfReading> {
  if (bytes.byteLength > MAX_PDF_BYTES) throw new PdfProblem(`it is larger than ${MAX_PDF_BYTES / 1e6} MB`);
  if (!looksLikePdf(bytes)) throw new PdfProblem('it is not a PDF');
  let result = await inWorker(bytes, opts.worker ?? WORKER, opts.timeoutMs ?? 120_000);
  if (typeof result === 'object' && 'started' in result) {
    opts.onFallback?.(result.detail);
    result = await readPdfPages(bytes).catch((err): PdfWorkerFailure => ({ ok: false, reason: 'broken', detail: describeError(err) }));
  }
  if (result === 'timeout') throw new PdfProblem('reading it took too long');
  if (!result.ok) {
    throw new PdfProblem(
      result.reason === 'password'
        ? 'it is locked with a password'
        : result.reason === 'missing'
          ? 'the PDF reader (pdf.js) is not installed here: run pnpm install, then start Noema again'
          : 'it could not be read as a PDF',
      result.detail,
    );
  }
  const reading = pdfToMarkdown(result.pages, { title: result.title });
  if (reading.pages > 0 && reading.emptyPages === reading.pages) {
    throw new PdfProblem('it has no text to read: it may be scanned pages or pictures, which Noema cannot read');
  }
  return reading;
}

/** The file kept with a version, as text for the store. */
export function pdfToRaw(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

export function rawToPdf(raw: string): Uint8Array {
  return new Uint8Array(Buffer.from(raw, 'base64'));
}
