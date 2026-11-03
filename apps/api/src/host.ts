/**
 * One-process production host for free PaaS (Northflank, etc.):
 * API + built SPA + in-process panorama worker. Needs Postgres only
 * (STORAGE_DRIVER=database, QUEUE_DRIVER=inline). No Redis, no S3.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Job } from 'bullmq';
import {
  createDb,
  createLogger,
  createStorage,
  loadEnvFiles,
  sceneJobId,
  storageKeys,
  type ProcessSceneJobData,
} from '@btv/core';
import { createSceneProcessor } from '@btv/worker';
import { createApp, createRateLimiters, loadApiConfig } from './app.js';
import { createInlineSceneQueue } from './inline-queue.js';

const here = dirname(fileURLToPath(import.meta.url));
loadEnvFiles(resolve(here, '..'));

process.env.QUEUE_DRIVER ??= 'inline';
process.env.STORAGE_DRIVER ??= 'database';

const platformOrigin =
  process.env.RENDER_EXTERNAL_URL ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : undefined);
if (platformOrigin) {
  process.env.WEB_ORIGIN ??= platformOrigin;
  process.env.CORS_ORIGINS ??= platformOrigin;
}

const config = loadApiConfig();
if (config.QUEUE_DRIVER !== 'inline') {
  throw new Error('host.ts requires QUEUE_DRIVER=inline');
}
if (config.STORAGE_DRIVER !== 'database') {
  throw new Error('host.ts requires STORAGE_DRIVER=database');
}

const logger = createLogger({
  name: 'host',
  level: config.LOG_LEVEL,
  pretty: config.NODE_ENV === 'development',
});

const dbHandle = createDb(config.DATABASE_URL);
const storage = createStorage(config, { db: dbHandle.db });
const maxInputPixels = Number(process.env.MAX_INPUT_PIXELS ?? 33_554_432);
const processor = createSceneProcessor({
  db: dbHandle.db,
  storage,
  logger,
  maxInputPixels: Number.isFinite(maxInputPixels) ? maxInputPixels : 33_554_432,
});

const queue = createInlineSceneQueue({
  attempts: config.JOB_ATTEMPTS,
  logger,
  run: async (sceneId, attempt, attempts) => {
    const job = {
      id: sceneJobId(sceneId),
      data: { sceneId },
      attemptsMade: attempt,
      opts: { attempts },
      updateProgress: async () => undefined,
    } as unknown as Job<ProcessSceneJobData>;
    await processor(job);
  },
});

const webDist = resolve(here, '../../web/dist');
const list = (value: string | undefined) =>
  (value ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

const app = createApp({
  config,
  db: dbHandle.db,
  logger,
  storage,
  queue,
  limiters: createRateLimiters(config),
  checks: {
    database: () => dbHandle.db.execute(sql`select 1`),
    storage: () => storage.head(storageKeys.original('00000000-0000-0000-0000-000000000000')),
  },
  spa: {
    dir: webDist,
    mediaOrigins: list(process.env.CSP_MEDIA_ORIGINS),
    embedAncestors: list(process.env.EMBED_FRAME_ANCESTORS ?? '*'),
  },
});

if (process.env.MIGRATE_ON_START !== '0') {
  const folder = resolve(here, '../../../packages/core/drizzle');
  try {
    await migrate(dbHandle.db, { migrationsFolder: folder });
    logger.info('database migrations applied');
  } catch (err) {
    const cause = err instanceof Error && 'cause' in err ? err.cause : err;
    console.error('database migrate failed:', cause ?? err);
    throw err;
  }
}

const server = app.listen(config.PORT, '0.0.0.0', () => {
  logger.info(`host listening on http://0.0.0.0:${config.PORT}`);
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down host');
  const force = setTimeout(() => process.exit(1), 60_000);
  force.unref();
  server.close(async () => {
    await Promise.allSettled([queue.close(), dbHandle.close()]);
    process.exit(0);
  });
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
