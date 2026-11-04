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
  /** Read and validate the JSON body. */
  body<S extends z.ZodTypeAny>(schema: S): Promise<z.output<S>>;
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

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'body_too_large', `request body over ${MAX_BODY_BYTES} bytes`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
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
        body: async (schema) => {
          const type = req.headers['content-type'] ?? '';
          if (!type.includes('application/json')) throw new HttpError(415, 'unsupported_media_type', 'send application/json');
          const raw = await readBody(req);
          let json: unknown;
          try {
            json = raw ? JSON.parse(raw) : {};
          } catch {
            throw new HttpError(400, 'bad_json', 'the request body is not valid JSON');
          }
          const parsed = schema.safeParse(json);
          if (!parsed.success) {
            const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
            throw new HttpError(400, 'invalid_request', issues);
          }
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
