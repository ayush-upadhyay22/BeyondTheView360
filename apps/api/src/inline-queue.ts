import type { Logger, SceneQueue } from '@btv/core';

/**
 * In-process job queue for hosts that have no Redis. One scene at a time so Sharp
 * stays inside a small free-tier memory limit.
 */
export function createInlineSceneQueue(opts: {
  run: (sceneId: string, attempt: number, attempts: number) => Promise<void>;
  attempts: number;
  logger: Logger;
}): SceneQueue {
  const pending = new Set<string>();
  let tail = Promise.resolve();

  async function process(sceneId: string): Promise<void> {
    for (let attempt = 0; attempt < opts.attempts; attempt++) {
      try {
        await opts.run(sceneId, attempt, opts.attempts);
        return;
      } catch (err) {
        const name = err instanceof Error ? err.name : '';
        const last = name === 'UnrecoverableError' || attempt + 1 >= opts.attempts;
        opts.logger[last ? 'error' : 'warn'](
          { err, sceneId, attempt: attempt + 1 },
          last ? 'inline scene job failed' : 'inline scene job retrying',
        );
        if (last) return;
      }
    }
  }

  return {
    async enqueue(sceneId) {
      if (pending.has(sceneId)) return;
      pending.add(sceneId);
      tail = tail
        .then(() => process(sceneId))
        .catch((err: unknown) => opts.logger.error({ err, sceneId }, 'inline queue crashed'))
        .finally(() => {
          pending.delete(sceneId);
        });
    },
    async ping() {
      /* no Redis */
    },
    async close() {
      await tail;
    },
  };
}
