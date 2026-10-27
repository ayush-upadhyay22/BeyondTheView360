import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import {
  createDb,
  createLogger,
  createSceneQueue,
  createStorage,
  loadEnvFiles,
  storageKeys,
} from '@btv/core';
import { createApp, createRateLimiters, loadApiConfig } from './app.js';

const here = dirname(fileURLToPath(import.meta.url));
loadEnvFiles(resolve(here, '..'));

const config = loadApiConfig();
const logger = createLogger({
  name: 'api',
  level: config.LOG_LEVEL,
  pretty: config.NODE_ENV === 'development',
});

const dbHandle = createDb(config.DATABASE_URL);
const storage = createStorage(config);
const queue = createSceneQueue(config.REDIS_URL, {
  attempts: config.JOB_ATTEMPTS,
  backoffMs: config.JOB_BACKOFF_MS,
});

const app = createApp({
  config,
  db: dbHandle.db,
  logger,
  storage,
  queue,
  limiters: createRateLimiters(config),
  checks: {
    database: () => dbHandle.db.execute(sql`select 1`),
    redis: () => queue.ping(),
    storage: () => storage.head(storageKeys.original('00000000-0000-0000-0000-000000000000')),
  },
});

const server = app.listen(config.PORT, () => {
  logger.info(`API listening on http://localhost:${config.PORT}`);
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down API');
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  server.close(async () => {
    await Promise.allSettled([dbHandle.close(), queue.close()]);
    process.exit(0);
  });
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
