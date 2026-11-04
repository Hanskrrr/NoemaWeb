// Server-sent events. Plain HTTP, works through Vite's proxy, and the
// browser's EventSource reconnects on its own.

import type { ServerResponse } from 'node:http';

export const HEARTBEAT_MS = 15_000;

export class SseStream {
  private readonly res: ServerResponse;
  private readonly heartbeat: NodeJS.Timeout;
  private closed = false;

  constructor(res: ServerResponse) {
    this.res = res;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.flushHeaders();
    res.write('retry: 1000\n\n');
    this.heartbeat = setInterval(() => this.comment('keep-alive'), HEARTBEAT_MS);
    this.heartbeat.unref();
    res.on('close', () => this.close());
  }

  get isClosed(): boolean {
    return this.closed;
  }

  send(event: string, data: unknown): void {
    if (this.closed) return;
    const payload = JSON.stringify(data);
    this.res.write(`event: ${event}\ndata: ${payload}\n\n`);
  }

  comment(text: string): void {
    if (!this.closed) this.res.write(`: ${text}\n\n`);
  }

  onClose(fn: () => void): void {
    this.res.on('close', fn);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    this.res.end();
  }
}
