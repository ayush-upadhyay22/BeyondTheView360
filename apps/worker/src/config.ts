import type { z } from 'zod';
import { baseEnvSchema, envInt, parseEnv, queueEnvSchema, storageEnvSchema } from '@btv/core';

export const workerEnvSchema = baseEnvSchema
  .merge(storageEnvSchema)
  .merge(queueEnvSchema)
  .extend({
    WORKER_CONCURRENCY: envInt(2, 1, 64),
    MAX_INPUT_PIXELS: envInt(268_435_456, 1_000_000, 1_073_741_824),
    STUCK_SCENE_MINUTES: envInt(15, 1, 24 * 60),
    SWEEP_INTERVAL_SECONDS: envInt(60, 5, 3600),
    PENDING_UPLOAD_TTL_HOURS: envInt(24, 1, 24 * 30),
  });

export type WorkerConfig = z.infer<typeof workerEnvSchema>;

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return parseEnv(workerEnvSchema, env);
}
