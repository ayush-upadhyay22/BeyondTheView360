import { cpus } from 'node:os';
import { Queue, Worker, type Job } from 'bullmq';
import sharp from 'sharp';
import { and, eq, inArray, lt } from 'drizzle-orm';
import {
  allSceneKeys,
  createRedisConnection,
  DEAD_LETTER_QUEUE,
  SCENE_QUEUE,
  sceneJobId,
  sceneJobOptions,
  scenes,
  PROCESS_SCENE_JOB,
  type Database,
  type DeadLetterJobData,
  type Logger,
  type ProcessSceneJobData,
  type StorageDriver,
} from '@btv/core';
import { createSceneProcessor, type ProcessResult } from './processor.js';
import type { WorkerConfig } from './config.js';

export interface WorkerDeps {
  config: WorkerConfig;
  db: Database;
  storage: StorageDriver;
  logger: Logger;
}

export interface RunningWorker {
  worker: Worker<ProcessSceneJobData, ProcessResult>;
  /** One pass of the stuck-scene / abandoned-upload sweeper (also runs on an interval). */
  sweep: () => Promise<{ requeued: number; abandoned: number }>;
  close: () => Promise<void>;
}

export function startWorker(deps: WorkerDeps): RunningWorker {
  const { config, db, storage, logger } = deps;

  // Split CPU threads between concurrent jobs so libvips doesn't oversubscribe the machine.
  sharp.concurrency(Math.max(1, Math.floor(cpus().length / config.WORKER_CONCURRENCY)));
  sharp.cache({ memory: 256, files: 0 });

  const workerConnection = createRedisConnection(config.REDIS_URL, 'worker');
  const queueConnection = createRedisConnection(config.REDIS_URL, 'worker');
  const prefix = config.QUEUE_PREFIX;
  const queue = new Queue<ProcessSceneJobData>(SCENE_QUEUE, {
    connection: queueConnection,
    prefix,
    defaultJobOptions: sceneJobOptions({
      attempts: config.JOB_ATTEMPTS,
      backoffMs: config.JOB_BACKOFF_MS,
      prefix,
    }),
  });
  const deadLetters = new Queue<DeadLetterJobData>(DEAD_LETTER_QUEUE, {
    connection: queueConnection,
    prefix,
  });

  const processor = createSceneProcessor({
    db,
    storage,
    logger,
    maxInputPixels: config.MAX_INPUT_PIXELS,
  });

  const worker = new Worker<ProcessSceneJobData, ProcessResult>(SCENE_QUEUE, processor, {
    connection: workerConnection,
    prefix,
    concurrency: config.WORKER_CONCURRENCY,
    // A crashed/killed worker's job is detected as stalled and handed to another worker.
    stalledInterval: 30_000,
    maxStalledCount: 2,
    lockDuration: 60_000,
  });

  worker.on('ready', () =>
    logger.info({ concurrency: config.WORKER_CONCURRENCY }, 'worker ready, waiting for jobs'),
  );
  worker.on('error', (err) => logger.error({ err }, 'worker error'));
  worker.on('stalled', (jobId) => logger.warn({ jobId }, 'job stalled; it will be retried'));
  worker.on('failed', (job: Job<ProcessSceneJobData> | undefined, err: Error) => {
    if (!job) return;
    const exhausted =
      err.name === 'UnrecoverableError' || job.attemptsMade >= (job.opts.attempts ?? 1);
    if (!exhausted) return;
    // Dead-letter: the failed job stays in BullMQ's failed set and a copy goes to the DLQ.
    const entry: DeadLetterJobData = {
      sceneId: job.data.sceneId,
      originalJobId: job.id,
      attemptsMade: job.attemptsMade,
      reason: err.message,
      failedAt: new Date().toISOString(),
    };
    logger.error({ deadLetter: entry }, 'job moved to dead-letter queue');
    deadLetters
      .add('dead-letter', entry, { removeOnComplete: false, removeOnFail: false })
      .catch((dlqErr: unknown) => logger.error({ err: dlqErr }, 'failed to write dead letter'));
  });

  async function sweep() {
    const stuckBefore = new Date(Date.now() - config.STUCK_SCENE_MINUTES * 60_000);
    const stuck = await db
      .select({ id: scenes.id })
      .from(scenes)
      .where(
        and(inArray(scenes.status, ['queued', 'processing']), lt(scenes.updatedAt, stuckBefore)),
      )
      .limit(100);

    let requeued = 0;
    for (const { id } of stuck) {
      const job = await queue.getJob(sceneJobId(id));
      const state = job ? await job.getState() : 'missing';
      if (
        state === 'waiting' ||
        state === 'active' ||
        state === 'delayed' ||
        state === 'prioritized'
      ) {
        continue; // Still in the queue: just a backlog, not stuck.
      }
      if (job) await job.remove().catch(() => undefined);
      await db
        .update(scenes)
        .set({ status: 'queued', progress: 0, queuedAt: new Date() })
        .where(eq(scenes.id, id));
      await queue.add(PROCESS_SCENE_JOB, { sceneId: id }, { jobId: sceneJobId(id) });
      requeued++;
      logger.warn({ sceneId: id, previousState: state }, 'recovered stuck scene');
    }

    // Uploads that were presigned but never completed.
    const abandonedBefore = new Date(Date.now() - config.PENDING_UPLOAD_TTL_HOURS * 3600_000);
    const abandoned = await db
      .delete(scenes)
      .where(and(eq(scenes.status, 'pending'), lt(scenes.createdAt, abandonedBefore)))
      .returning({ id: scenes.id, variants: scenes.variants });
    if (abandoned.length) {
      await storage.delete(abandoned.flatMap(allSceneKeys)).catch(() => undefined);
      logger.info({ count: abandoned.length }, 'removed abandoned uploads');
    }
    return { requeued, abandoned: abandoned.length };
  }

  let sweeping = false;
  const timer = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    sweep()
      .catch((err: unknown) => logger.error({ err }, 'sweeper failed'))
      .finally(() => {
        sweeping = false;
      });
  }, config.SWEEP_INTERVAL_SECONDS * 1000);
  timer.unref();

  return {
    worker,
    sweep,
    async close() {
      clearInterval(timer);
      // Waits for active jobs to finish; unfinished ones are retried by another worker.
      await worker.close();
      await Promise.allSettled([queue.close(), deadLetters.close()]);
      workerConnection.disconnect();
      queueConnection.disconnect();
    },
  };
}
