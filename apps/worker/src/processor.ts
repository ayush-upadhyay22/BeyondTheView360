import { UnrecoverableError, type Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import {
  allSceneKeys,
  IMMUTABLE_CACHE,
  scenes,
  StorageNotFoundError,
  storageKeys,
  type Database,
  type Logger,
  type ProcessSceneJobData,
  type StorageDriver,
} from '@btv/core';
import { PermanentError } from './errors.js';
import { processPanorama } from './image/pipeline.js';

export interface ProcessorDeps {
  db: Database;
  storage: StorageDriver;
  logger: Logger;
  maxInputPixels: number;
}

export type ProcessResult =
  { status: 'ready'; variants: number[] } | { status: 'skipped'; reason: string };

export const TRANSIENT_FAILURE_MESSAGE =
  'Processing failed after several attempts. Please try again in a few minutes.';

/** Whether this attempt is the job's last one (BullMQ counts attemptsMade after a failure). */
export function isFinalAttempt(job: Pick<Job, 'attemptsMade' | 'opts'>): boolean {
  return job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
}

export function createSceneProcessor(deps: ProcessorDeps) {
  const { db, storage, logger } = deps;

  return async function processScene(job: Job<ProcessSceneJobData>): Promise<ProcessResult> {
    const { sceneId } = job.data;
    const log = logger.child({ sceneId, jobId: job.id, attempt: job.attemptsMade + 1 });

    const [scene] = await db.select().from(scenes).where(eq(scenes.id, sceneId)).limit(1);
    if (!scene) {
      log.info('scene no longer exists; skipping');
      return { status: 'skipped', reason: 'deleted' };
    }
    // Idempotency: a duplicate or replayed job for a finished scene is a no-op.
    if (scene.status === 'ready') {
      return { status: 'skipped', reason: 'already-ready' };
    }
    if (scene.status === 'pending') {
      return { status: 'skipped', reason: 'upload-not-completed' };
    }

    const setProgress = async (progress: number) => {
      await db.update(scenes).set({ progress }).where(eq(scenes.id, sceneId));
      await job.updateProgress(progress);
    };

    try {
      await db
        .update(scenes)
        .set({ status: 'processing', progress: 5, error: null })
        .where(eq(scenes.id, sceneId));
      await job.updateProgress(5);

      let original: Buffer;
      try {
        original = await storage.get(scene.originalKey);
      } catch (err) {
        if (err instanceof StorageNotFoundError) {
          throw new PermanentError('The uploaded file is missing. Please upload it again.');
        }
        throw err;
      }

      log.info({ bytes: original.length }, 'processing panorama');
      const result = await processPanorama(original, {
        maxInputPixels: deps.maxInputPixels,
        onProgress: (p) => setProgress(Math.max(5, Math.min(95, p))),
      });

      // Overwrites are safe, so a retried job simply rewrites the same keys.
      await Promise.all([
        ...result.variants.map((v) =>
          storage.put(storageKeys.variant(sceneId, v.width), v.data, {
            contentType: 'image/webp',
            cacheControl: IMMUTABLE_CACHE,
          }),
        ),
        storage.put(storageKeys.thumbnail(sceneId), result.thumbnail, {
          contentType: 'image/jpeg',
          cacheControl: IMMUTABLE_CACHE,
        }),
        storage.put(storageKeys.placeholder(sceneId), result.placeholder, {
          contentType: 'image/webp',
          cacheControl: IMMUTABLE_CACHE,
        }),
      ]);

      const variants = result.variants.map((v) => v.width);
      const updated = await db
        .update(scenes)
        .set({
          status: 'ready',
          progress: 100,
          error: null,
          width: result.width,
          height: result.height,
          variants,
          placeholder: result.placeholderDataUrl,
          thumbKey: storageKeys.thumbnail(sceneId),
          processedAt: new Date(),
        })
        .where(eq(scenes.id, sceneId))
        .returning({ id: scenes.id });

      if (updated.length === 0) {
        // Deleted while we were working: don't leave orphans behind.
        await storage.delete(allSceneKeys({ id: sceneId, variants }));
        return { status: 'skipped', reason: 'deleted-during-processing' };
      }
      log.info({ variants }, 'scene ready');
      return { status: 'ready', variants };
    } catch (err) {
      const permanent = err instanceof PermanentError;
      const final = permanent || isFinalAttempt(job);
      log[final ? 'error' : 'warn'](
        { err, permanent, final },
        permanent ? 'scene rejected' : 'scene processing attempt failed',
      );
      await db
        .update(scenes)
        .set(
          final
            ? {
                status: 'failed',
                progress: 0,
                error: permanent ? (err as Error).message : TRANSIENT_FAILURE_MESSAGE,
              }
            : { status: 'queued', progress: 0, error: null },
        )
        .where(eq(scenes.id, sceneId))
        .catch((dbErr: unknown) => log.error({ err: dbErr }, 'failed to record scene failure'));
      // UnrecoverableError makes BullMQ fail the job immediately without retries.
      if (permanent) throw new UnrecoverableError((err as Error).message);
      throw err;
    }
  };
}
