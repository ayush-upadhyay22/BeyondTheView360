/**
 * One-process production host (free PaaS / AWS free tier):
 * API + built SPA + in-process panorama worker.
 *
 * Defaults: QUEUE_DRIVER=inline, STORAGE_DRIVER=database (Postgres only).
 * On AWS, set STORAGE_DRIVER=s3 + S3_BUCKET and attach an IAM role (leave access keys empty).
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
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

applyPlatformDefaults();

const config = loadApiConfig();
if (config.QUEUE_DRIVER !== 'inline') {
  throw new Error('host.ts requires QUEUE_DRIVER=inline');
}

const logger = createLogger({
  name: 'host',
  level: config.LOG_LEVEL,
  pretty: config.NODE_ENV === 'development',
});

sharp.cache({ memory: 32, files: 0, items: 10 });
sharp.concurrency(1);

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

/** Fill WEB_ORIGIN / CORS / CSP from known PaaS + AWS env when the operator did not set them. */
function applyPlatformDefaults(): void {
  // EB / CloudFormation sometimes inject empty strings; treat those as unset.
  for (const key of [
    'WEB_ORIGIN',
    'CORS_ORIGINS',
    'AWS_APP_URL',
    'EB_PUBLIC_URL',
    'S3_ENDPOINT',
    'S3_ACCESS_KEY_ID',
    'S3_SECRET_ACCESS_KEY',
    'CSP_MEDIA_ORIGINS',
  ] as const) {
    if (process.env[key]?.trim() === '') delete process.env[key];
  }

  const platformOrigin = detectPlatformOrigin();
  if (platformOrigin) {
    process.env.WEB_ORIGIN ??= platformOrigin;
    process.env.CORS_ORIGINS ??= platformOrigin;
  }

  if (
    (process.env.STORAGE_DRIVER ?? 'database') === 's3' &&
    process.env.S3_BUCKET &&
    !process.env.CSP_MEDIA_ORIGINS
  ) {
    const region = process.env.S3_REGION || 'us-east-1';
    const bucket = process.env.S3_BUCKET;
    process.env.CSP_MEDIA_ORIGINS =
      region === 'us-east-1'
        ? `https://${bucket}.s3.amazonaws.com,https://${bucket}.s3.us-east-1.amazonaws.com`
        : `https://${bucket}.s3.${region}.amazonaws.com`;
  }

  // Elastic Beanstalk / ALB sit in front of the app.
  if (
    process.env.TRUST_PROXY === undefined &&
    (process.env.AWS_EXECUTION_ENV ||
      process.env.ELASTIC_BEANSTALK_ENVIRONMENT_NAME ||
      process.env.AWS_APP_RUNNER_SERVICE_ARN)
  ) {
    process.env.TRUST_PROXY = '1';
  }
}

function detectPlatformOrigin(): string | undefined {
  const strip = (url: string) => url.replace(/\/+$/, '');
  if (process.env.RENDER_EXTERNAL_URL) return strip(process.env.RENDER_EXTERNAL_URL);
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    return strip(`https://${process.env.RAILWAY_PUBLIC_DOMAIN}`);
  }
  // Set by aws/cloudformation.yml or the EB environment console.
  if (process.env.AWS_APP_URL) return strip(process.env.AWS_APP_URL);
  if (process.env.EB_PUBLIC_URL) return strip(process.env.EB_PUBLIC_URL);
  return undefined;
}
