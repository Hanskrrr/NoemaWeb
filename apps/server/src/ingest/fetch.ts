// Reading a page by its address: fetched on this machine (a browser could not,
// because of CORS), turned into Markdown with core's htmlToMarkdown, kept with
// the original HTML. An arXiv paper is read from its HTML version, not its
// abstract page or PDF. PDFs are refused with a reason, for now.

import { htmlToMarkdown } from '@noema/core';

// 2: aligned equations (LaTeXML align) as one aligned block, not a table.
// 3: pipes in a table cell's math written \vert and \Vert, so a norm keeps its cell;
//    aligned equations as align* with each row's \tag, numbers in the margin.
export const EXTRACTOR = 'noema-html-3';

export class FetchProblem extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FetchProblem';
  }
}

export interface ImportedPage {
  title: string;
  markdown: string;
  /** The address actually read. */
  fetchedUrl: string;
  raw: string;
  /** 'html' when it was turned into Markdown; 'text' when it was text already. */
  kind: 'html' | 'text';
}

export interface FetchOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

const ARXIV = /^https?:\/\/(?:www\.|export\.)?arxiv\.org\/(?:abs|pdf|html)\/([a-z.-]*\/?\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?(?:\.pdf)?\/?(?:[?#].*)?$/i;

/**
 * Where to read a page from, in order. For an arXiv paper (abstract, PDF or
 * HTML link): arXiv's own HTML, then ar5iv's, which also covers older papers.
 */
export function readingAddresses(url: string): string[] {
  const m = ARXIV.exec(url.trim());
  if (!m) return [url.trim()];
  const id = m[1] as string;
  const version = m[2] ?? '';
  return [`https://arxiv.org/html/${id}${version}`, `https://ar5iv.labs.arxiv.org/html/${id}`];
}

function charsetOf(contentType: string, head: Uint8Array): string {
  const fromHeader = /charset\s*=\s*"?([\w-]+)/i.exec(contentType)?.[1];
  if (fromHeader) return fromHeader;
  const sniff = new TextDecoder('latin1').decode(head.subarray(0, 4096));
  return /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(sniff)?.[1] ?? 'utf-8';
}

function decode(bytes: Uint8Array, contentType: string): string {
  const charset = charsetOf(contentType, bytes);
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw new FetchProblem(`it is larger than ${Math.round(maxBytes / 1e6)} MB`);
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new FetchProblem(`it is larger than ${Math.round(maxBytes / 1e6)} MB`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

async function fetchOne(address: string, opts: Required<FetchOptions>): Promise<ImportedPage> {
  let res: Response;
  try {
    res = await opts.fetch(address, {
      redirect: 'follow',
      signal: AbortSignal.timeout(opts.timeoutMs),
      headers: {
        'user-agent': 'Noema/0.1 (a local study notebook)',
        accept: 'text/html,application/xhtml+xml,text/markdown,text/plain;q=0.9,*/*;q=0.5',
      },
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new FetchProblem(timedOut ? 'it took too long to answer' : 'it could not be reached');
  }
  if (!res.ok) throw new FetchProblem(`it answered ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`);
  const type = (res.headers.get('content-type') ?? '').toLowerCase();
  const finalUrl = res.url || address;
  if (type.includes('application/pdf') || /\.pdf(?:[?#]|$)/i.test(finalUrl)) {
    throw new FetchProblem('it is a PDF, which Noema cannot read yet. For a paper, give its arXiv link; or paste the text');
  }
  const isHtml = type.includes('html') || type.includes('xml') || type === '';
  const isText = type.startsWith('text/') || type.includes('markdown') || type.includes('json');
  if (!isHtml && !isText) throw new FetchProblem(`it is not a page or text (${type.split(';')[0]})`);
  const raw = decode(await readCapped(res, opts.maxBytes), type);
  if (isHtml && /<html|<body|<p[\s>]|<div|<article/i.test(raw.slice(0, 50_000))) {
    const page = htmlToMarkdown(raw, { url: finalUrl });
    if (!page.markdown.trim()) throw new FetchProblem('no readable text was found in it');
    return { title: page.title, markdown: page.markdown, fetchedUrl: finalUrl, raw, kind: 'html' };
  }
  if (!raw.trim()) throw new FetchProblem('it is empty');
  const firstHeading = /^#\s+(.+)$/m.exec(raw)?.[1]?.trim();
  return { title: firstHeading ?? '', markdown: raw.replace(/\r\n?/g, '\n').trim(), fetchedUrl: finalUrl, raw, kind: 'text' };
}

/** Read the page at `url` (an arXiv paper from its HTML version). Throws FetchProblem with a reason a learner can read. */
export async function importPage(url: string, options: FetchOptions = {}): Promise<ImportedPage> {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new FetchProblem('that is not a web address');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new FetchProblem('only http and https addresses can be read');
  const opts: Required<FetchOptions> = {
    fetch: options.fetch ?? fetch,
    timeoutMs: options.timeoutMs ?? 20_000,
    maxBytes: options.maxBytes ?? 15_000_000,
  };
  const addresses = readingAddresses(parsed.href);
  let last: FetchProblem | null = null;
  for (const address of addresses) {
    try {
      return await fetchOne(address, opts);
    } catch (err) {
      last = err instanceof FetchProblem ? err : new FetchProblem('it could not be read');
    }
  }
  throw last ?? new FetchProblem('it could not be read');
}
