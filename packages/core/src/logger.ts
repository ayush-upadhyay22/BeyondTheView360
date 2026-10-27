import { pino, type Logger, type LoggerOptions } from 'pino';

export type { Logger };

/** Paths that must never reach the logs. */
export const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-amz-security-token"]',
  'res.headers["set-cookie"]',
  'password',
  '*.password',
  'passwordHash',
  '*.passwordHash',
  'token',
  '*.token',
  'secretAccessKey',
  '*.secretAccessKey',
  'S3_SECRET_ACCESS_KEY',
  'DATABASE_URL',
  'REDIS_URL',
];

export function createLogger(opts: { name: string; level: string; pretty?: boolean }): Logger {
  const options: LoggerOptions = {
    name: opts.name,
    level: opts.level,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  };
  if (opts.pretty) {
    options.transport = {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
    };
  }
  return pino(options);
}
