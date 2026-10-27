import { Queue, type JobsOptions } from 'bullmq';
import { Redis, type RedisOptions } from 'ioredis';

export const SCENE_QUEUE = 'scene-processing';
/** Permanently failed jobs are copied here for inspection / manual replay. */
export const DEAD_LETTER_QUEUE = 'scene-processing-dead-letter';
export const PROCESS_SCENE_JOB = 'process-scene';

export interface ProcessSceneJobData {
  sceneId: string;
}

export interface DeadLetterJobData {
  sceneId: string;
  originalJobId: string | undefined;
  attemptsMade: number;
  reason: string;
  failedAt: string;
}

/** One job id per scene makes enqueueing idempotent: duplicates are ignored by BullMQ. */
export const sceneJobId = (sceneId: string) => `scene-${sceneId}`;

/**
 * Workers need `maxRetriesPerRequest: null` (blocking commands must never time out);
 * producers should fail fast instead of hanging an HTTP request when Redis is down.
 */
export function createRedisConnection(url: string, role: 'worker' | 'producer'): Redis {
  const options: RedisOptions =
    role === 'worker'
      ? { maxRetriesPerRequest: null, enableReadyCheck: true }
      : { maxRetriesPerRequest: 2, enableOfflineQueue: false, connectTimeout: 5000 };
  return new Redis(url, options);
}

export interface QueueOptions {
  attempts: number;
  backoffMs: number;
  prefix: string;
}

export function sceneJobOptions(opts: QueueOptions): JobsOptions {
  return {
    attempts: opts.attempts,
    backoff: { type: 'exponential', delay: opts.backoffMs },
    removeOnComplete: { age: 24 * 3600, count: 1000 },
    // Failed jobs are kept (dead-letter visibility); trimmed only by age.
    removeOnFail: { age: 30 * 24 * 3600 },
  };
}

export interface SceneQueue {
  /** Idempotent: a scene that is already waiting/active is not enqueued twice. */
  enqueue(sceneId: string): Promise<void>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export function createSceneQueue(redisUrl: string, opts: QueueOptions): SceneQueue {
  const connection = createRedisConnection(redisUrl, 'producer');
  const queue = new Queue<ProcessSceneJobData>(SCENE_QUEUE, {
    connection,
    prefix: opts.prefix,
    defaultJobOptions: sceneJobOptions(opts),
  });
  return {
    async enqueue(sceneId) {
      const jobId = sceneJobId(sceneId);
      const existing = await queue.getJob(jobId);
      if (existing) {
        const state = await existing.getState();
        if (state === 'completed' || state === 'failed') {
          // Finished runs keep their id; remove so the scene can be processed again (retry).
          await existing.remove();
        } else {
          return;
        }
      }
      await queue.add(PROCESS_SCENE_JOB, { sceneId }, { jobId });
    },
    async ping() {
      await connection.ping();
    },
    async close() {
      await queue.close();
      connection.disconnect();
    },
  };
}
