/**
 * Structured application logging.
 *
 * One JSON line per event, always carrying request_id and org_id when known, so
 * a single request can be reconstructed across the API, the job queue and the
 * provider adapters. Values are redacted by key name before they are written.
 */
import 'server-only';

type Level = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const LEVEL_ORDER: Record<Level, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

const REDACT_KEYS = new Set([
  'password',
  'token',
  'access_token',
  'refresh_token',
  'api_key',
  'apikey',
  'secret',
  'client_secret',
  'authorization',
  'cookie',
  'set-cookie',
  'service_role_key',
  'anon_key',
  'encrypted_password',
  'signature',
  'x-hub-signature',
]);

export interface LogContext {
  request_id?: string;
  org_id?: string;
  user_id?: string;
  [key: string]: unknown;
}

function currentLevel(): Level {
  const raw = process.env.LOG_LEVEL as Level | undefined;
  return raw && raw in LEVEL_ORDER ? raw : 'info';
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth-limit]';
  if (value === null || value === undefined) return value;
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEYS.has(k.toLowerCase()) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 2000) {
    return `${value.slice(0, 2000)}…[truncated]`;
  }
  return value;
}

function write(level: Level, message: string, context: LogContext = {}): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel()]) return;

  const entry = {
    level,
    time: new Date().toISOString(),
    msg: message,
    ...(redact(context) as Record<string, unknown>),
  };

  const line = JSON.stringify(entry);
  if (level === 'error' || level === 'fatal') {
    process.stderr.write(`${line}\n`);
  } else {
    process.stdout.write(`${line}\n`);
  }
}

export interface Logger {
  trace(msg: string, ctx?: LogContext): void;
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
  fatal(msg: string, ctx?: LogContext): void;
  child(bindings: LogContext): Logger;
}

function make(bindings: LogContext): Logger {
  const bound = (level: Level) => (msg: string, ctx: LogContext = {}) =>
    write(level, msg, { ...bindings, ...ctx });

  return {
    trace: bound('trace'),
    debug: bound('debug'),
    info: bound('info'),
    warn: bound('warn'),
    error: bound('error'),
    fatal: bound('fatal'),
    child: (extra) => make({ ...bindings, ...extra }),
  };
}

export const logger: Logger = make({});
export const createLogger = (bindings: LogContext): Logger => make(bindings);
