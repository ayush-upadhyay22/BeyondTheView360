import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

/**
 * Loads `<dir>/.env` if present. Outside production it falls back to `<dir>/.env.example`
 * (safe local defaults) so a fresh clone runs without copying files. Existing environment
 * variables always win.
 */
export function loadEnvFiles(dir: string): string | null {
  const isProd = process.env.NODE_ENV === 'production';
  const candidates = isProd ? ['.env'] : ['.env', '.env.example'];
  for (const name of candidates) {
    const file = resolve(dir, name);
    if (existsSync(file)) {
      process.loadEnvFile(file);
      return file;
    }
  }
  return null;
}

const emptyToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

export const envBool = (defaultValue: boolean) =>
  z.preprocess(
    emptyToUndefined,
    z
      .enum(['true', 'false', '1', '0', 'yes', 'no'])
      .optional()
      .transform((v) => (v === undefined ? defaultValue : ['true', '1', 'yes'].includes(v))),
  );

export const envOptionalString = z.preprocess(emptyToUndefined, z.string().trim().optional());
export const envOptionalUrl = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .url()
    .optional()
    .transform((v) => v?.replace(/\/+$/, '')),
);
export const envInt = (defaultValue: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.preprocess(emptyToUndefined, z.coerce.number().int().min(min).max(max).default(defaultValue));

export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
});

export const storageEnvSchema = z.object({
  STORAGE_DRIVER: z.enum(['s3']).default('s3'),
  S3_BUCKET: z.string().min(3),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_ENDPOINT: envOptionalUrl,
  S3_PUBLIC_ENDPOINT: envOptionalUrl,
  S3_FORCE_PATH_STYLE: envBool(false),
  S3_ACCESS_KEY_ID: envOptionalString,
  S3_SECRET_ACCESS_KEY: envOptionalString,
  PUBLIC_BASE_URL: envOptionalUrl,
  SIGNED_URL_TTL_SECONDS: envInt(3600, 60, 7 * 24 * 3600),
});

export const queueEnvSchema = z.object({
  JOB_ATTEMPTS: envInt(3, 1, 20),
  JOB_BACKOFF_MS: envInt(5000, 100, 10 * 60_000),
});

/** Parses env with a zod schema and throws one readable error listing every problem. */
export function parseEnv<T extends z.ZodTypeAny>(
  schema: T,
  env: NodeJS.ProcessEnv = process.env,
): z.infer<T> {
  const result = schema.safeParse(env);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  return result.data;
}
