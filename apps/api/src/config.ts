import { z } from 'zod';
import {
  baseEnvSchema,
  envBool,
  envInt,
  envOptionalString,
  parseEnv,
  queueEnvSchema,
  storageEnvSchema,
} from '@btv/core';

const originList = z
  .string()
  .default('http://localhost:5173')
  .transform((s) =>
    s
      .split(',')
      .map((o) => o.trim().replace(/\/+$/, ''))
      .filter(Boolean),
  );

export const apiEnvSchema = baseEnvSchema
  .merge(storageEnvSchema)
  .merge(queueEnvSchema)
  .extend({
    PORT: envInt(4000, 1, 65535),
    CORS_ORIGINS: originList,
    WEB_ORIGIN: z
      .string()
      .url()
      .default('http://localhost:5173')
      .transform((s) => s.replace(/\/+$/, '')),
    TRUST_PROXY: envInt(0, 0, 10),
    SESSION_TTL_DAYS: envInt(30, 1, 365),
    COOKIE_SECURE: envOptionalString,
    UPLOAD_URL_TTL_SECONDS: envInt(900, 60, 3600),
    JSON_BODY_LIMIT: z.string().default('100kb'),
    RATE_LIMIT_ENABLED: envBool(true),
  });

export type ApiEnv = z.infer<typeof apiEnvSchema>;

export interface ApiConfig extends ApiEnv {
  cookieSecure: boolean;
  isProduction: boolean;
}

export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = parseEnv(apiEnvSchema, env);
  const cookieSecure =
    parsed.COOKIE_SECURE === undefined
      ? parsed.NODE_ENV === 'production'
      : ['true', '1', 'yes'].includes(parsed.COOKIE_SECURE.toLowerCase());
  return { ...parsed, cookieSecure, isProduction: parsed.NODE_ENV === 'production' };
}
