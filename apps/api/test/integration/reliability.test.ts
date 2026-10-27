import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import type { SceneDTO } from '@btv/shared';
import {
  createRedisConnection,
  DEAD_LETTER_QUEUE,
  scenes,
  storageKeys,
  type StorageDriver,
} from '@btv/core';
import { TRANSIENT_FAILURE_MESSAGE } from '@btv/worker';
import {
  bootStack,
  integrationEnabled,
  newUser,
  panorama,
  uploadToPresigned,
  waitForScene,
  type Stack,
} from './helpers.js';

/** Storage whose `get` fails a configurable number of times per key (simulated outage). */
function flaky(failures: Map<string, number>) {
  return (inner: StorageDriver): StorageDriver => ({
    name: `flaky-${inner.name}`,
    put: (k, b, o) => inner.put(k, b, o),
    head: (k) => inner.head(k),
    delete: (k) => inner.delete(k),
    presignUpload: (o) => inner.presignUpload(o),
    publicUrl: (k, o) => inner.publicUrl(k, o),
    async get(key) {
      const left = failures.get(key) ?? 0;
      if (left > 0) {
        failures.set(key, left - 1);
        throw new Error('simulated network failure');
      }
      return inner.get(key);
    },
  });
}

describe.skipIf(!integrationEnabled)('worker reliability', () => {
  const failures = new Map<string, number>();
  let stack: Stack;

  beforeAll(async () => {
    stack = await bootStack({
      wrapStorage: flaky(failures),
      // Sweeper disabled on a timer here; the test calls sweep() explicitly.
      workerEnv: { SWEEP_INTERVAL_SECONDS: '3600', STUCK_SCENE_MINUTES: '1' },
    });
  }, 30_000);

  afterAll(async () => {
    await stack?.close();
  });

  async function uploadScene(user: Awaited<ReturnType<typeof newUser>>) {
    const tour = (await user.send('post', '/api/tours', { title: 'Reliability' })).body.tour;
    const data = await panorama(2048, 1024);
    const presign = await user.send('post', '/api/scenes/presign', {
      tourId: tour.id,
      filename: 'r.jpg',
      contentType: 'image/jpeg',
      size: data.length,
    });
    await uploadToPresigned(presign.body.upload, data, 'image/jpeg');
    return presign.body.scene as SceneDTO;
  }

  it('retries transient failures with backoff and then succeeds', async () => {
    const user = await newUser(stack.app);
    const scene = await uploadScene(user);
    failures.set(storageKeys.original(scene.id), 2); // attempts 1 and 2 fail, 3 succeeds
    await user.send('post', `/api/scenes/${scene.id}/complete`).expect(202);

    const done: SceneDTO = await waitForScene(
      user.agent,
      scene.id,
      (s) => s === 'ready' || s === 'failed',
    );
    expect(done.status).toBe('ready');
    expect(failures.get(storageKeys.original(scene.id))).toBe(0);
  }, 60_000);

  it('marks the scene failed and dead-letters the job after all attempts', async () => {
    const user = await newUser(stack.app);
    const scene = await uploadScene(user);
    failures.set(storageKeys.original(scene.id), 99);
    await user.send('post', `/api/scenes/${scene.id}/complete`).expect(202);

    const done: SceneDTO = await waitForScene(
      user.agent,
      scene.id,
      (s) => s === 'ready' || s === 'failed',
    );
    expect(done.status).toBe('failed');
    expect(done.error).toBe(TRANSIENT_FAILURE_MESSAGE);

    const conn = createRedisConnection(stack.redisUrl, 'worker');
    const dlq = new Queue(DEAD_LETTER_QUEUE, { connection: conn, prefix: stack.prefix });
    try {
      let entries: { data: { sceneId: string; attemptsMade: number } }[] = [];
      for (let i = 0; i < 20 && !entries.some((e) => e.data.sceneId === scene.id); i++) {
        entries = await dlq.getJobs(['waiting']);
        await new Promise((r) => setTimeout(r, 100));
      }
      const entry = entries.find((e) => e.data.sceneId === scene.id);
      expect(entry?.data.attemptsMade).toBe(3);
    } finally {
      await dlq.close();
      conn.disconnect();
    }

    // After the outage, the user can retry.
    failures.set(storageKeys.original(scene.id), 0);
    await user.send('post', `/api/scenes/${scene.id}/retry`).expect(202);
    const retried: SceneDTO = await waitForScene(
      user.agent,
      scene.id,
      (s) => s === 'ready' || s === 'failed',
    );
    expect(retried.status).toBe('ready');
  }, 60_000);

  it('recovers scenes stuck in "queued" without a job (e.g. Redis was down)', async () => {
    const user = await newUser(stack.app);
    const scene = await uploadScene(user);
    // Simulate: upload completed but the enqueue never happened, long ago.
    await stack.db.execute(
      sql`update ${scenes} set status = 'queued', updated_at = now() - interval '10 minutes'
          where ${scenes.id} = ${scene.id}`,
    );

    const result = await stack.worker.sweep();
    expect(result.requeued).toBeGreaterThanOrEqual(1);
    const done: SceneDTO = await waitForScene(
      user.agent,
      scene.id,
      (s) => s === 'ready' || s === 'failed',
    );
    expect(done.status).toBe('ready');
  }, 60_000);
});
