import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { CSRF_HEADER, CSRF_HEADER_VALUE, type PublicTourDTO, type SceneDTO } from '@btv/shared';
import {
  bootStack,
  integrationEnabled,
  newUser,
  panorama,
  uploadToPresigned,
  waitForScene,
  type Stack,
} from './helpers.js';

type User = Awaited<ReturnType<typeof newUser>>;

describe.skipIf(!integrationEnabled)('public tour page, embed data and view counts', () => {
  let stack: Stack;
  let owner: User;
  let tour: { id: string; shareId: string };
  let ready: SceneDTO;
  let pendingSceneId: string;

  beforeAll(async () => {
    stack = await bootStack();
    owner = await newUser(stack.app);
    tour = (await owner.send('post', '/api/tours', { title: 'Open house' })).body.tour;

    // One processed scene…
    const data = await panorama(2048, 1024);
    const presign = await owner.send('post', '/api/scenes/presign', {
      tourId: tour.id,
      filename: 'hall.jpg',
      contentType: 'image/jpeg',
      size: data.length,
    });
    await uploadToPresigned(presign.body.upload, data, 'image/jpeg');
    await owner.send('post', `/api/scenes/${presign.body.scene.id}/complete`);
    ready = await waitForScene(owner.agent, presign.body.scene.id, (s) => s === 'ready');

    // …and one that never finishes uploading, with a link to it from the ready scene.
    const pending = await owner.send('post', '/api/scenes/presign', {
      tourId: tour.id,
      filename: 'attic.jpg',
      contentType: 'image/jpeg',
      size: 1000,
    });
    pendingSceneId = pending.body.scene.id;
    await owner.send('post', `/api/scenes/${ready.id}/hotspots`, {
      type: 'link',
      yaw: 10,
      pitch: 0,
      targetSceneId: pendingSceneId,
    });
    await owner.send('post', `/api/scenes/${ready.id}/hotspots`, {
      type: 'info',
      yaw: -30,
      pitch: 5,
      title: 'Fireplace <b>original</b>',
      text: 'Built in 1920.',
    });
  }, 90_000);

  afterAll(async () => {
    await stack?.close();
  });

  const anon = () => request(stack.app);
  const ping = (agent: request.SuperTest<request.Test> | request.Agent) =>
    agent
      .post(`/api/public/tours/${tour.shareId}/views`)
      .set(CSRF_HEADER, CSRF_HEADER_VALUE)
      .send({});

  it('hides private tours from everyone but the owner', async () => {
    expect((await anon().get(`/api/public/tours/${tour.shareId}`)).status).toBe(404);
    const stranger = await newUser(stack.app);
    expect((await stranger.agent.get(`/api/public/tours/${tour.shareId}`)).status).toBe(404);
    expect((await ping(anon())).status).toBe(404);

    const own = await owner.agent.get(`/api/public/tours/${tour.shareId}`);
    expect(own.status).toBe(200);
    expect(own.body.tour.visibility).toBe('private');
  });

  it('serves unlisted tours with only ready scenes and valid links', async () => {
    await owner.send('patch', `/api/tours/${tour.id}`, { visibility: 'unlisted' });
    const res = await anon().get(`/api/public/tours/${tour.shareId}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');

    const body = res.body.tour as PublicTourDTO;
    expect(body.title).toBe('Open house');
    expect(body.scenes.map((s) => s.id)).toEqual([ready.id]);
    expect(body.startSceneId).toBe(ready.id);
    const hotspots = body.scenes[0]!.hotspots;
    // The link to the unfinished scene is dropped; text is returned verbatim (escaped by React).
    expect(hotspots.map((h) => h.type)).toEqual(['info']);
    expect(hotspots[0]!.title).toBe('Fireplace <b>original</b>');
    // No owner or internal fields leak.
    expect(JSON.stringify(body)).not.toMatch(/ownerId|originalKey|email/);
    expect(body.scenes[0]!.variants[0]!.url).toMatch(/X-Amz-Signature=/);
  });

  it('rejects malformed share ids', async () => {
    expect((await anon().get('/api/public/tours/..%2F..%2Fetc')).status).toBe(400);
    expect((await anon().get('/api/public/tours/x')).status).toBe(400);
  });

  it('counts anonymous views per day but not the owner’s own', async () => {
    expect((await ping(anon())).status).toBe(204);
    expect((await ping(anon())).status).toBe(204);
    expect((await ping(owner.agent)).status).toBe(204);

    const stats = await owner.agent.get(`/api/tours/${tour.id}/stats`);
    expect(stats.status).toBe(200);
    expect(stats.body.total).toBe(2);
    const today = new Date().toISOString().slice(0, 10);
    expect(stats.body.daily).toEqual([{ day: today, count: 2 }]);

    const list = await owner.agent.get('/api/tours');
    expect(list.body.tours.find((t: { id: string }) => t.id === tour.id).viewCount).toBe(2);
  });

  it('requires the CSRF header and an allowed origin for view pings', async () => {
    const noHeader = await anon().post(`/api/public/tours/${tour.shareId}/views`).send({});
    expect(noHeader.status).toBe(403);
    const evil = await anon()
      .post(`/api/public/tours/${tour.shareId}/views`)
      .set(CSRF_HEADER, CSRF_HEADER_VALUE)
      .set('Origin', 'https://evil.example')
      .send({});
    expect(evil.status).toBe(403);
  });

  it('stops serving a tour once it is made private again', async () => {
    await owner.send('patch', `/api/tours/${tour.id}`, { visibility: 'private' });
    expect((await anon().get(`/api/public/tours/${tour.shareId}`)).status).toBe(404);
  });
});
