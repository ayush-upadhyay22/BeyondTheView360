import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { SceneDTO } from '@btv/shared';
import {
  bootStack,
  integrationEnabled,
  newUser,
  panorama,
  uploadToPresigned,
  waitForScene,
  type Stack,
} from './helpers.js';

describe.skipIf(!integrationEnabled)('upload → S3 → queue → worker → ready', () => {
  let stack: Stack;

  beforeAll(async () => {
    stack = await bootStack();
  }, 30_000);

  afterAll(async () => {
    await stack?.close();
  });

  async function createTour(user: Awaited<ReturnType<typeof newUser>>, title = 'Test tour') {
    const res = await user.send('post', '/api/tours', { title });
    expect(res.status).toBe(201);
    return res.body.tour as { id: string; shareId: string };
  }

  async function presignAndUpload(
    user: Awaited<ReturnType<typeof newUser>>,
    tourId: string,
    data: Buffer,
    contentType = 'image/jpeg',
    filename = 'lobby.jpg',
  ) {
    const presign = await user.send('post', '/api/scenes/presign', {
      tourId,
      filename,
      contentType,
      size: data.length,
    });
    expect(presign.status).toBe(201);
    expect(presign.body.scene.status).toBe('pending');
    const upload = await uploadToPresigned(presign.body.upload, data, contentType);
    expect(upload.status).toBeLessThan(300);
    return presign.body.scene as SceneDTO;
  }

  it('processes a valid panorama into variants, thumbnail and placeholder', async () => {
    const user = await newUser(stack.app);
    const tour = await createTour(user);
    const scene = await presignAndUpload(user, tour.id, await panorama(4096, 2048));
    expect(scene.name).toBe('lobby');

    const complete = await user.send('post', `/api/scenes/${scene.id}/complete`);
    expect(complete.status).toBe(202);
    expect(['queued', 'processing', 'ready']).toContain(complete.body.scene.status);

    // Completing twice is harmless.
    const again = await user.send('post', `/api/scenes/${scene.id}/complete`);
    expect(again.status).toBe(202);

    const ready: SceneDTO = await waitForScene(
      user.agent,
      scene.id,
      (s) => s === 'ready' || s === 'failed',
    );
    expect(ready.status).toBe('ready');
    expect(ready.progress).toBe(100);
    expect([ready.width, ready.height]).toEqual([4096, 2048]);
    expect(ready.variants.map((v) => v.width)).toEqual([1024, 2048, 4096]);
    expect(ready.placeholder).toMatch(/^data:image\/webp;base64,/);
    expect(ready.thumbUrl).toBeTruthy();

    // Signed URLs actually serve the processed images.
    const img = await fetch(ready.variants[0]!.url);
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/webp');
    const thumb = await fetch(ready.thumbUrl!);
    expect(thumb.headers.get('content-type')).toBe('image/jpeg');

    // The tour lists the scene with a cover thumbnail.
    const list = await user.agent.get('/api/tours');
    const summary = list.body.tours.find((t: { id: string }) => t.id === tour.id);
    expect(summary.sceneCount).toBe(1);
    expect(summary.thumbnailUrl).toBeTruthy();
  }, 90_000);

  it('accepts a 3:1 strip and letterboxes it to 2:1', async () => {
    const user = await newUser(stack.app);
    const tour = await createTour(user);
    const scene = await presignAndUpload(
      user,
      tour.id,
      await panorama(3000, 1000),
      'image/png',
      'banner.png',
    );
    await user.send('post', `/api/scenes/${scene.id}/complete`).expect(202);

    const ready: SceneDTO = await waitForScene(
      user.agent,
      scene.id,
      (s) => s === 'failed' || s === 'ready',
    );
    expect(ready.status).toBe('ready');
    expect(ready.width).toBe(3000);
    expect(ready.height).toBe(1500);
  }, 60_000);

  it('fails permanently for a portrait photo', async () => {
    const user = await newUser(stack.app);
    const tour = await createTour(user);
    const scene = await presignAndUpload(
      user,
      tour.id,
      await panorama(2000, 3000),
      'image/jpeg',
      'portrait.jpg',
    );
    await user.send('post', `/api/scenes/${scene.id}/complete`).expect(202);

    const failed: SceneDTO = await waitForScene(
      user.agent,
      scene.id,
      (s) => s === 'failed' || s === 'ready',
    );
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/portrait/);
    expect(failed.variants).toEqual([]);
  }, 60_000);

  it('rejects files that are not images even if declared as JPEG', async () => {
    const user = await newUser(stack.app);
    const tour = await createTour(user);
    const scene = await presignAndUpload(
      user,
      tour.id,
      Buffer.from('not really a jpeg'.repeat(100)),
    );
    await user.send('post', `/api/scenes/${scene.id}/complete`).expect(202);
    const failed: SceneDTO = await waitForScene(
      user.agent,
      scene.id,
      (s) => s === 'failed' || s === 'ready',
    );
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/JPEG, PNG or WebP/);
  }, 60_000);

  it('refuses to complete when nothing was uploaded', async () => {
    const user = await newUser(stack.app);
    const tour = await createTour(user);
    const presign = await user.send('post', '/api/scenes/presign', {
      tourId: tour.id,
      filename: 'ghost.jpg',
      contentType: 'image/jpeg',
      size: 1000,
    });
    const res = await user.send('post', `/api/scenes/${presign.body.scene.id}/complete`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('upload_missing');
  });

  it('validates presign input and plan limits', async () => {
    const user = await newUser(stack.app);
    const tour = await createTour(user);
    const base = { tourId: tour.id, filename: 'a.jpg', contentType: 'image/jpeg', size: 1000 };

    const gif = await user.send('post', '/api/scenes/presign', {
      ...base,
      contentType: 'image/gif',
    });
    expect(gif.status).toBe(400);

    const big = await user.send('post', '/api/scenes/presign', { ...base, size: 6 * 1024 * 1024 });
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe('file_too_large');
  });

  it('S3 itself rejects uploads larger than the policy allows', async () => {
    const user = await newUser(stack.app);
    const tour = await createTour(user);
    const presign = await user.send('post', '/api/scenes/presign', {
      tourId: tour.id,
      filename: 'liar.jpg',
      contentType: 'image/jpeg',
      size: 1000, // lies about the size
    });
    const tooBig = Buffer.alloc(6 * 1024 * 1024, 1);
    const res = await uploadToPresigned(presign.body.upload, tooBig, 'image/jpeg');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await res.text()).toMatch(/EntityTooLarge|exceeds|too large/i);
  });

  it('enforces ownership on tours, scenes and hotspots (404 for other users)', async () => {
    const alice = await newUser(stack.app);
    const mallory = await newUser(stack.app);
    const tour = await createTour(alice, 'Alice tour');
    const presign = await alice.send('post', '/api/scenes/presign', {
      tourId: tour.id,
      filename: 'room.jpg',
      contentType: 'image/jpeg',
      size: 1000,
    });
    const sceneId = presign.body.scene.id as string;
    const hs = await alice.send('post', `/api/scenes/${sceneId}/hotspots`, {
      type: 'info',
      yaw: 10,
      pitch: 5,
      title: 'Window',
    });
    expect(hs.status).toBe(201);
    const hotspotId = hs.body.hotspot.id as string;

    const checks = [
      await mallory.agent.get(`/api/tours/${tour.id}`),
      await mallory.send('patch', `/api/tours/${tour.id}`, { title: 'pwned' }),
      await mallory.send('delete', `/api/tours/${tour.id}`),
      await mallory.agent.get(`/api/scenes/${sceneId}`),
      await mallory.send('patch', `/api/scenes/${sceneId}`, { name: 'pwned' }),
      await mallory.send('post', `/api/scenes/${sceneId}/complete`),
      await mallory.send('post', `/api/scenes/${sceneId}/hotspots`, {
        type: 'info',
        yaw: 0,
        pitch: 0,
        title: 'x',
      }),
      await mallory.send('patch', `/api/hotspots/${hotspotId}`, { title: 'pwned' }),
      await mallory.send('delete', `/api/hotspots/${hotspotId}`),
      await mallory.send('post', '/api/scenes/presign', {
        tourId: tour.id,
        filename: 'x.jpg',
        contentType: 'image/jpeg',
        size: 10,
      }),
    ];
    for (const res of checks) expect(res.status).toBe(404);

    const mine = await mallory.agent.get('/api/tours');
    expect(mine.body.tours).toEqual([]);
    const still = await alice.agent.get(`/api/tours/${tour.id}`);
    expect(still.body.tour.title).toBe('Alice tour');
  });

  it('requires auth and the CSRF header', async () => {
    const anon = request(stack.app);
    expect((await anon.get('/api/tours')).status).toBe(401);
    const user = await newUser(stack.app);
    const res = await user.agent.post('/api/tours').send({ title: 'no csrf header' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('csrf');
    const evil = await user.agent
      .post('/api/tours')
      .set('x-btv-csrf', '1')
      .set('origin', 'https://evil.example')
      .send({ title: 'cross-site' });
    expect(evil.status).toBe(403);
  });
});
