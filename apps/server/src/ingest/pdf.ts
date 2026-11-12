// Reading a PDF: pdf.js finds the text of each page (in a worker thread, with
// a time limit), core's pdfToMarkdown makes it Markdown. The file itself is
// kept with the version (base64, in `raw`), so it can be opened at a page and
// read again by a later reader without the network.

import { Worker } from 'node:worker_threads';
import { type PdfReading, pdfToMarkdown } from '@noema/core';
import type { PdfWorkerFailure, PdfWorkerResult } from './pdf-worker.ts';

// 1: lines, paragraphs, headings, lists and page headings from pdf.js 6 text items.
export const PDF_EXTRACTOR = 'noema-pdf-1';

/** Largest PDF read, from a file or an address. */
export const MAX_PDF_BYTES = 50_000_000;

const WORKER = new URL('./pdf-worker.ts', import.meta.url);

export class PdfProblem extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfProblem';
  }
}

/** Does it start like a PDF? (Within the first kilobyte, as readers allow.) */
export function looksLikePdf(bytes: Uint8Array): boolean {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  return head.includes('%PDF-');
}

/**
 * The text of a PDF as Markdown. Throws PdfProblem with a reason a learner
 * can read: not a PDF, locked, unreadable, too slow, or no text at all.
 */
export async function readPdf(bytes: Uint8Array, opts: { timeoutMs?: number } = {}): Promise<PdfReading> {
  if (bytes.byteLength > MAX_PDF_BYTES) throw new PdfProblem(`it is larger than ${MAX_PDF_BYTES / 1e6} MB`);
  if (!looksLikePdf(bytes)) throw new PdfProblem('it is not a PDF');
  const result = await new Promise<PdfWorkerResult | PdfWorkerFailure | 'timeout'>((resolve, reject) => {
    // A copy: the worker owns its bytes.
    const worker = new Worker(WORKER, { workerData: bytes.slice(), resourceLimits: { maxOldGenerationSizeMb: 2048 } });
    const timer = setTimeout(() => {
      void worker.terminate();
      resolve('timeout');
    }, opts.timeoutMs ?? 120_000);
    worker.once('message', (m: PdfWorkerResult | PdfWorkerFailure) => {
      clearTimeout(timer);
      resolve(m);
      void worker.terminate();
    });
    worker.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    worker.once('exit', () => {
      clearTimeout(timer);
      resolve({ ok: false, reason: 'broken' });
    });
  }).catch((): PdfWorkerFailure => ({ ok: false, reason: 'broken' }));
  if (result === 'timeout') throw new PdfProblem('reading it took too long');
  if (!result.ok) {
    throw new PdfProblem(
      result.reason === 'password'
        ? 'it is locked with a password'
        : result.reason === 'missing'
          ? 'the PDF reader (pdf.js) is not installed here: run pnpm install, then start Noema again'
          : 'it could not be read as a PDF',
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
