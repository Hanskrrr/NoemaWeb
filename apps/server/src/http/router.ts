// A small router over node:http. Enough for a local single-user API, with
// JSON bodies validated by Zod and errors in one shape: { error: { code, message } }.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { z } from 'zod';

export class HttpError extends Error {
  override name = 'HttpError';
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  /** Read and validate the JSON body (at most 1 MB unless `maxBytes` says more). */
  body<S extends z.ZodTypeAny>(schema: S, opts?: { maxBytes?: number }): Promise<z.output<S>>;
  /** Read the body as bytes (a file), of the given media type; `tooLarge` is the sentence when it is over `maxBytes`. */
  bytes(opts: { type: string; maxBytes: number; tooLarge: string }): Promise<Uint8Array>;
  /** Read and validate the query string. */
  query<S extends z.ZodTypeAny>(schema: S): z.output<S>;
}

export type Handler = (ctx: Ctx) => Promise<void> | void;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

const MAX_BODY_BYTES = 1_000_000;

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

export function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  sendJson(res, status, { error: { code, message } });
}

async function readRaw(req: IncomingMessage, max: number, tooLarge?: string): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? 0);
  const over = () => new HttpError(413, 'body_too_large', tooLarge ?? `request body over ${max} bytes`);
  if (declared > max) throw over();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw over();
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readBody(req: IncomingMessage, max = MAX_BODY_BYTES): Promise<string> {
  return (await readRaw(req, max)).toString('utf8');
}

function invalid(error: z.ZodError, where: string): HttpError {
  const issues = error.issues.map((i) => `${i.path.join('.') || where}: ${i.message}`).join('; ');
  return new HttpError(400, 'invalid_request', issues);
}

export class Router {
  private readonly routes: Route[] = [];

  on(method: string, path: string, handler: Handler): this {
    const keys: string[] = [];
    const source = path.replace(/:([a-zA-Z]+)/g, (_, key: string) => {
      keys.push(key);
      return '([^/]+)';
    });
    this.routes.push({ method, pattern: new RegExp(`^${source}$`), keys, handler });
    return this;
  }

  /** Returns false when no route matched the path, so the caller can serve static files. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    let pathMatched = false;
    for (const route of this.routes) {
      const m = route.pattern.exec(url.pathname);
      if (!m) continue;
      pathMatched = true;
      if (route.method !== req.method) continue;
      const params: Record<string, string> = {};
      for (const [i, k] of route.keys.entries()) params[k] = decodeURIComponent(m[i + 1] ?? '');
      const ctx: Ctx = {
        req,
        res,
        url,
        params,
        body: async (schema, opts) => {
          const type = req.headers['content-type'] ?? '';
          if (!type.includes('application/json'))
            throw new HttpError(415, 'unsupported_media_type', 'send application/json');
          const raw = await readBody(req, opts?.maxBytes);
          let json: unknown;
          try {
            json = raw ? JSON.parse(raw) : {};
          } catch {
            throw new HttpError(400, 'bad_json', 'the request body is not valid JSON');
          }
          const parsed = schema.safeParse(json);
          if (!parsed.success) throw invalid(parsed.error, 'body');
          return parsed.data;
        },
        bytes: async ({ type, maxBytes, tooLarge }) => {
          const sent = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
          if (sent !== type) throw new HttpError(415, 'unsupported_media_type', `send ${type}`);
          const raw = await readRaw(req, maxBytes, tooLarge);
          return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
        },
        query: (schema) => {
          const parsed = schema.safeParse(Object.fromEntries(url.searchParams));
          if (!parsed.success) throw invalid(parsed.error, 'query');
          return parsed.data;
        },
      };
      await route.handler(ctx);
      return true;
    }
    if (pathMatched) throw new HttpError(405, 'method_not_allowed', `${req.method} is not allowed here`);
    return false;
  }
}
