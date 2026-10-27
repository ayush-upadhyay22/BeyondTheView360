import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '@btv/shared';
import {
  createDb,
  createLogger,
  createSceneQueue,
  createStorage,
  loadEnvFiles,
  type StorageDriver,
} from '@btv/core';
import { loadWorkerConfig, startWorker } from '@btv/worker';
import { createApp, createRateLimiters, loadApiConfig } from '../../src/app.js';

const here = dirname(fileURLToPath(import.meta.url));

export const integrationEnabled = process.env.RUN_INTEGRATION === '1';

/** Boots the real API + an in-process worker against the local stack (Postgres/Redis/MinIO). */
export async function bootStack(
  opts: { wrapStorage?: (s: StorageDriver) => StorageDriver; workerEnv?: NodeJS.ProcessEnv } = {},
) {
  loadEnvFiles(resolve(here, '../..'));
  // Small limits make the S3 size-policy test cheap.
  process.env.PLAN_FREE_MAX_UPLOAD_MB = '5';
  process.env.PLAN_FREE_MAX_TOURS = '50';
  // Each stack gets its own BullMQ namespace so a running dev worker never steals test jobs.
  const prefix = `itest-${randomBytes(4).toString('hex')}`;
  const env = {
    ...process.env,
    RATE_LIMIT_ENABLED: 'false',
    LOG_LEVEL: 'error',
    QUEUE_PREFIX: prefix,
  };
  const config = loadApiConfig(env);
  const logger = createLogger({ name: 'itest', level: 'fatal' });
  const dbHandle = createDb(config.DATABASE_URL);
  await dbHandle.db.execute(sql`select 1`);
  const realStorage = createStorage(config);
  const storage = opts.wrapStorage ? opts.wrapStorage(realStorage) : realStorage;
  const queue = createSceneQueue(config.REDIS_URL, { attempts: 3, backoffMs: 200, prefix });
  const workerConfig = loadWorkerConfig({
    ...env,
    JOB_BACKOFF_MS: '200',
    WORKER_CONCURRENCY: '2',
    ...opts.workerEnv,
  });

  const worker = startWorker({ config: workerConfig, db: dbHandle.db, storage, logger });

  const app = createApp({
    config,
    db: dbHandle.db,
    logger,
    storage,
    queue,
    limiters: createRateLimiters(config),
    checks: {},
  });

  return {
    app,
    db: dbHandle.db,
    storage: realStorage,
    worker,
    prefix,
    redisUrl: config.REDIS_URL,
    async close() {
      await worker.close();
      await queue.close();
      await dbHandle.close();
    },
  };
}

export type Stack = Awaited<ReturnType<typeof bootStack>>;

/** A logged-in supertest agent with CSRF header helpers. */
export async function newUser(app: Stack['app']) {
  const agent = request.agent(app);
  const email = `user-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
  const res = await agent
    .post('/api/auth/signup')
    .set(CSRF_HEADER, CSRF_HEADER_VALUE)
    .send({ email, password: 'integration-password' });
  if (res.status !== 201)
    throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`);
  const send = (method: 'post' | 'patch' | 'put' | 'delete', url: string, body?: object) =>
    agent[method](url).set(CSRF_HEADER, CSRF_HEADER_VALUE).send(body);
  return { agent, email, send };
}

export async function panorama(width: number, height: number, format: 'jpeg' | 'png' = 'jpeg') {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1e3a8a"/><stop offset="1" stop-color="#f59e0b"/></linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/></svg>`;
  const img = sharp(Buffer.from(svg));
  return format === 'png' ? img.png().toBuffer() : img.jpeg({ quality: 85 }).toBuffer();
}

/** Uploads like a browser would: multipart POST of the presigned fields followed by the file. */
export async function uploadToPresigned(
  upload: { url: string; fields: Record<string, string> },
  data: Buffer,
  contentType: string,
): Promise<Response> {
  const form = new FormData();
  for (const [k, v] of Object.entries(upload.fields)) form.append(k, v);
  form.append('file', new Blob([new Uint8Array(data)], { type: contentType }), 'upload');
  return fetch(upload.url, { method: 'POST', body: form });
}

export async function waitForScene(
  agent: request.Agent,
  sceneId: string,
  done: (status: string) => boolean,
  timeoutMs = 60_000,
) {
  const started = Date.now();
  for (;;) {
    const res = await agent.get(`/api/scenes/${sceneId}`);
    if (res.status !== 200) throw new Error(`poll failed: ${res.status}`);
    if (done(res.body.scene.status)) return res.body.scene;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out waiting for scene; last status ${res.body.scene.status}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}
