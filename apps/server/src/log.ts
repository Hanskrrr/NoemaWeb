// One JSON object per line on stdout: easy to read, easy to grep, easy to
// paste into a bug report. Never log message content or API keys.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const;
export type Level = keyof typeof LEVELS;

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(level: Level = 'info', write: (line: string) => void = (l) => process.stdout.write(l)): Logger {
  const min = LEVELS[level];
  const emit = (lvl: Exclude<Level, 'silent'>, msg: string, fields?: Record<string, unknown>) => {
    if (LEVELS[lvl] < min) return;
    const extra: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields ?? {})) {
      extra[k] = v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v;
    }
    write(`${JSON.stringify({ t: new Date().toISOString(), level: lvl, msg, ...extra })}\n`);
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
  };
}

export const silentLogger: Logger = createLogger('silent');
