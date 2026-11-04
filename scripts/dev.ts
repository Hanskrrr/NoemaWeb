// `pnpm dev`: the server (restarts on change) and Vite (hot reload), together.
// Open http://127.0.0.1:5173. Ctrl+C stops both.

import { type ChildProcess, spawn } from 'node:child_process';

const windows = process.platform === 'win32';
const children: ChildProcess[] = [];

function run(name: string, color: number, command: string, args: string[]): void {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: windows, env: process.env });
  const prefix = `\x1b[${color}m${name.padEnd(6)}\x1b[0m│ `;
  const pipe = (stream: NodeJS.ReadableStream, out: NodeJS.WriteStream) => {
    let buffer = '';
    stream.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) out.write(`${prefix}${line}\n`);
    });
  };
  if (child.stdout) pipe(child.stdout, process.stdout);
  if (child.stderr) pipe(child.stderr, process.stderr);
  child.on('exit', (code) => {
    process.stdout.write(`${prefix}exited (${code ?? 'signal'})\n`);
    stop(code ?? 1);
  });
  children.push(child);
}

let stopping = false;
function stop(code: number): void {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 300).unref();
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

run('server', 36, process.execPath, ['--disable-warning=ExperimentalWarning', '--watch', 'apps/server/src/main.ts']);
run('web', 35, 'pnpm', ['--filter', '@noema/web', 'dev']);
