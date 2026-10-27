import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, createLogger, createStorage, loadEnvFiles } from '@btv/core';
import { loadWorkerConfig } from './config.js';
import { startWorker } from './worker.js';

const here = dirname(fileURLToPath(import.meta.url));
loadEnvFiles(resolve(here, '..'));

const config = loadWorkerConfig();
const logger = createLogger({
  name: 'worker',
  level: config.LOG_LEVEL,
  pretty: config.NODE_ENV === 'development',
});

const dbHandle = createDb(config.DATABASE_URL, { max: config.WORKER_CONCURRENCY + 2 });
const running = startWorker({
  config,
  db: dbHandle.db,
  storage: createStorage(config),
  logger,
});

// Recover anything left behind by a previous crash right away.
running
  .sweep()
  .then((r) => r.requeued && logger.info(r, 'startup sweep finished'))
  .catch((err: unknown) => logger.error({ err }, 'startup sweep failed'));

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down worker (finishing active jobs)…');
  const force = setTimeout(() => {
    logger.warn('forced exit; unfinished jobs will be retried');
    process.exit(1);
  }, 60_000);
  force.unref();
  await running.close().catch((err: unknown) => logger.error({ err }, 'error during close'));
  await dbHandle.close().catch(() => undefined);
  logger.info('worker stopped');
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
