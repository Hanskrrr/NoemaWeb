// The server has no login: it trusts whoever can reach it. So it must only be
// reachable by this machine's own browser tab.
// - It binds to loopback (config.ts refuses anything else).
// - Host must be a loopback name. This stops DNS rebinding, where a web page
//   on evil.example points its own hostname at 127.0.0.1.
// - State-changing requests need a custom header. A cross-site page cannot
//   send one without a CORS preflight, and we never approve preflights.
// - A cross-site Origin on a state-changing request is refused outright.

import type { IncomingMessage } from 'node:http';
import { CLIENT_HEADER, CLIENT_HEADER_VALUE } from '@noema/core';
import { HttpError } from './router.ts';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const SAFE_METHODS = new Set(['GET', 'HEAD']);

function hostname(hostHeader: string): string {
  if (hostHeader.startsWith('[')) return hostHeader.slice(0, hostHeader.indexOf(']') + 1);
  return hostHeader.split(':')[0] ?? '';
}

export function checkRequest(req: IncomingMessage): void {
  const host = req.headers.host ?? '';
  if (!LOOPBACK_HOSTS.has(hostname(host).toLowerCase())) {
    throw new HttpError(403, 'bad_host', 'this server only answers requests addressed to localhost');
  }
  if (req.method === 'OPTIONS') {
    throw new HttpError(403, 'cors_refused', 'cross-origin requests are not allowed');
  }
  if (SAFE_METHODS.has(req.method ?? '')) return;
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    let originHost = '';
    try {
      originHost = new URL(origin).hostname;
    } catch {
      // malformed origin: refuse below
    }
    if (!LOOPBACK_HOSTS.has(originHost.toLowerCase()) && !LOOPBACK_HOSTS.has(`[${originHost}]`)) {
      throw new HttpError(403, 'bad_origin', 'requests from other sites are not allowed');
    }
  }
  if (req.headers[CLIENT_HEADER] !== CLIENT_HEADER_VALUE) {
    throw new HttpError(403, 'missing_client_header', `state-changing requests need the ${CLIENT_HEADER} header`);
  }
}

export const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};

// KaTeX output uses inline style attributes, hence 'unsafe-inline' for styles only.
export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
