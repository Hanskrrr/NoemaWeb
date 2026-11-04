// Serves the built web app (apps/web/dist) in production. In development
// Vite serves it instead and proxies /api here.

import { createReadStream, statSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { CSP } from './guard.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function fileAt(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function serveStatic(root: string, pathname: string, res: ServerResponse): boolean {
  const base = resolve(root);
  let rel: string;
  try {
    rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  } catch {
    return false;
  }
  let file = join(base, rel);
  if (file !== base && !file.startsWith(base + sep)) return false; // path traversal
  const isAsset = /\.[a-z0-9]+$/i.test(rel);
  if (!fileAt(file)) {
    if (isAsset) return false;
    file = join(base, 'index.html'); // client-side routes
    if (!fileAt(file)) return false;
  }
  const ext = extname(file);
  const headers: Record<string, string> = { 'content-type': TYPES[ext] ?? 'application/octet-stream' };
  if (ext === '.html') {
    headers['content-security-policy'] = CSP;
    headers['cache-control'] = 'no-cache';
  } else if (rel.startsWith('assets/')) {
    headers['cache-control'] = 'public, max-age=31536000, immutable';
  }
  res.writeHead(200, headers);
  createReadStream(file).pipe(res);
  return true;
}
