import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  BACK_ARROW_YAW,
  CHAIN_ARROW_PITCH,
  MAX_HOTSPOTS_PER_SCENE,
  NEXT_ARROW_YAW,
  type HotspotDTO,
  type PublicTourDTO,
  type SceneDTO,
  type TourDTO,
} from '@btv/shared';
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

/** "next:Kitchen" style summary of a scene's arrows, for readable assertions. */
function arrows(tour: TourDTO, name: string): string[] {
  const byId = new Map(tour.scenes.map((s) => [s.id, s.name]));
  const scene = tour.scenes.find((s) => s.name === name)!;
  return scene.hotspots
    .filter((h) => h.kind === 'next' || h.kind === 'back')
    .map((h) => `${h.kind}:${byId.get(h.targetSceneId!)}`)
    .sort();
}

describe.skipIf(!integrationEnabled)('walk-through chain', () => {
  let stack: Stack;
  let image: Buffer;

  beforeAll(async () => {
    stack = await bootStack();
    image = await panorama(2048, 1024);
  }, 30_000);

  afterAll(async () => {
    await stack?.close();
  });

  async function createTour(user: User, title = 'House') {
    const res = await user.send('post', '/api/tours', { title });
    expect(res.status).toBe(201);
    return res.body.tour as TourDTO;
  }

  /** Uploads one file after the other, exactly like the editor does. */
  async function uploadInOrder(user: User, tourId: string, names: string[]) {
    const out: SceneDTO[] = [];
    for (const name of names) {
      const presign = await user.send('post', '/api/scenes/presign', {
        tourId,
        filename: `${name}.jpg`,
        contentType: 'image/jpeg',
        size: image.length,
      });
      expect(presign.status).toBe(201);
      const upload = await uploadToPresigned(presign.body.upload, image, 'image/jpeg');
      expect(upload.status).toBeLessThan(300);
      expect(
        (await user.send('post', `/api/scenes/${presign.body.scene.id}/complete`)).status,
      ).toBe(202);
      out.push(presign.body.scene);
    }
    for (const s of out) {
      expect(
        (await waitForScene(user.agent, s.id, (st) => st !== 'queued' && st !== 'processing'))
          .status,
      ).toBe('ready');
    }
    return out;
  }

  const getTour = async (user: User, id: string) =>
    (await user.agent.get(`/api/tours/${id}`)).body.tour as TourDTO;

  it('links Hall -> Kitchen -> Bedroom with back arrows, in upload order', async () => {
    const user = await newUser(stack.app);
    const tour = await createTour(user);
    const [hall, kitchen, bedroom] = await uploadInOrder(user, tour.id, [
      'Hall',
      'Kitchen',
      'Bedroom',
    ]);

    const t = await getTour(user, tour.id);
    expect(t.scenes.map((s) => s.name)).toEqual(['Hall', 'Kitchen', 'Bedroom']);
    expect(t.scenes.map((s) => s.position)).toEqual([0, 1, 2]);
    expect(arrows(t, 'Hall')).toEqual(['next:Kitchen']);
    expect(arrows(t, 'Kitchen')).toEqual(['back:Hall', 'next:Bedroom']);
    expect(arrows(t, 'Bedroom')).toEqual(['back:Kitchen']);

    const hallNext = t.scenes[0]!.hotspots.find((h) => h.kind === 'next')!;
    expect(hallNext).toMatchObject({
      targetSceneId: kitchen!.id,
      yaw: NEXT_ARROW_YAW,
      pitch: expect.closeTo(CHAIN_ARROW_PITCH, 3),
    });
    const kitchenBack = t.scenes[1]!.hotspots.find((h) => h.kind === 'back')!;
    expect(kitchenBack).toMatchObject({ targetSceneId: hall!.id, yaw: BACK_ARROW_YAW });
    expect(t.scenes[2]!.hotspots.find((h) => h.kind === 'back')!.targetSceneId).toBe(kitchen!.id);
    expect(bedroom).toBeTruthy();

    // The public tour exposes the same chain.
    await user.send('patch', `/api/tours/${tour.id}`, { visibility: 'unlisted' });
    const pub = (await request(stack.app).get(`/api/public/tours/${tour.shareId}`)).body
      .tour as PublicTourDTO;
    expect(pub.scenes.map((s) => s.hotspots.map((h) => h.kind).sort())).toEqual([
      ['next'],
      ['back', 'next'],
      ['back'],
    ]);
  }, 120_000);

  it('"link all in order" is idempotent and keeps custom hotspots', async () => {
    const user = await newUser(stack.app);
    const tour = await createTour(user);
    const [hall, kitchen, bedroom] = await uploadInOrder(user, tour.id, [
      'Hall',
      'Kitchen',
      'Bedroom',
    ]);

    // Owner deletes one arrow and adds a custom link + an info point.
    const before = await getTour(user, tour.id);
    const kitchenNext = before.scenes[1]!.hotspots.find((h) => h.kind === 'next')!;
    expect((await user.send('delete', `/api/hotspots/${kitchenNext.id}`)).status).toBe(204);
    const custom = await user.send('post', `/api/scenes/${hall!.id}/hotspots`, {
      kind: 'link',
      yaw: 90,
      pitch: 0,
      targetSceneId: bedroom!.id,
    });
    expect(custom.status).toBe(201);
    await user.send('post', `/api/scenes/${hall!.id}/hotspots`, {
      kind: 'info',
      yaw: -90,
      pitch: 10,
      title: 'Coat rack',
    });

    const first = await user.send('post', `/api/tours/${tour.id}/link-in-order`, {});
    expect(first.status).toBe(200);
    expect(first.body.result).toEqual({ added: 1, removed: 0 });
    const second = await user.send('post', `/api/tours/${tour.id}/link-in-order`, {});
    expect(second.body.result).toEqual({ added: 0, removed: 0 });

    const t = second.body.tour as TourDTO;
    expect(arrows(t, 'Kitchen')).toEqual(['back:Hall', 'next:Bedroom']);
    expect(t.scenes[0]!.hotspots.map((h) => h.kind).sort()).toEqual(['info', 'link', 'next']);

    // Reorder to Hall, Bedroom, Kitchen and rebuild: arrows follow, custom ones survive.
    const order = await user.send('put', `/api/tours/${tour.id}/scenes/order`, {
      sceneIds: [hall!.id, bedroom!.id, kitchen!.id],
    });
    expect(order.status).toBe(200);
    const rebuilt = await user.send('post', `/api/tours/${tour.id}/link-in-order`, {
      mode: 'rebuild',
    });
    expect(rebuilt.status).toBe(200);
    const r = rebuilt.body.tour as TourDTO;
    expect(arrows(r, 'Hall')).toEqual(['next:Bedroom']);
    expect(arrows(r, 'Bedroom')).toEqual(['back:Hall', 'next:Kitchen']);
    expect(arrows(r, 'Kitchen')).toEqual(['back:Bedroom']);
    expect(r.scenes[0]!.hotspots.some((h) => h.id === custom.body.hotspot.id)).toBe(true);
    const again = await user.send('post', `/api/tours/${tour.id}/link-in-order`, {
      mode: 'rebuild',
    });
    expect(again.body.result).toEqual({ added: 0, removed: 0 });
  }, 120_000);

  it('deleting a scene removes links to it, and ?relink=1 bridges its neighbours', async () => {
    const user = await newUser(stack.app);
    const tour = await createTour(user);
    const [hall, kitchen, bedroom, garden] = await uploadInOrder(user, tour.id, [
      'Hall',
      'Kitchen',
      'Bedroom',
      'Garden',
    ]);
    // Owner points the hall arrow at a door; bridging must keep that position.
    const t0 = await getTour(user, tour.id);
    const hallNext = t0.scenes[0]!.hotspots.find((h) => h.kind === 'next')!;
    await user.send('patch', `/api/hotspots/${hallNext.id}`, { yaw: 42.5, pitch: -20 });
    await user.send('post', `/api/scenes/${garden!.id}/hotspots`, {
      kind: 'link',
      yaw: 10,
      pitch: 0,
      targetSceneId: kitchen!.id,
    });

    expect((await user.send('delete', `/api/scenes/${kitchen!.id}?relink=1`)).status).toBe(204);
    const t1 = await getTour(user, tour.id);
    expect(t1.scenes.map((s) => s.name)).toEqual(['Hall', 'Bedroom', 'Garden']);
    expect(arrows(t1, 'Hall')).toEqual(['next:Bedroom']);
    expect(arrows(t1, 'Bedroom')).toEqual(['back:Hall', 'next:Garden']);
    const bridged = t1.scenes[0]!.hotspots.find((h) => h.kind === 'next')!;
    expect(bridged).toMatchObject({ id: hallNext.id, yaw: 42.5, pitch: -20 });
    // Nothing anywhere still points at the deleted scene.
    const all: HotspotDTO[] = t1.scenes.flatMap((s) => s.hotspots);
    expect(all.some((h) => h.targetSceneId === kitchen!.id)).toBe(false);

    // Without relink the chain simply ends.
    expect((await user.send('delete', `/api/scenes/${bedroom!.id}`)).status).toBe(204);
    const t2 = await getTour(user, tour.id);
    expect(arrows(t2, 'Hall')).toEqual([]);
    expect(arrows(t2, 'Garden')).toEqual([]);

    // A new upload continues after the last scene, using max(position) + 1.
    const [attic] = await uploadInOrder(user, tour.id, ['Attic']);
    const t3 = await getTour(user, tour.id);
    expect(t3.scenes.find((s) => s.id === attic!.id)!.position).toBe(4);
    expect(arrows(t3, 'Garden')).toEqual(['next:Attic']);
    expect(hall).toBeTruthy();
  }, 150_000);

  it('bridges the chain around a photo the worker rejects', async () => {
    const user = await newUser(stack.app);
    const tour = await createTour(user);
    const portrait = await panorama(2000, 3000);
    const ids: string[] = [];
    for (const [name, data] of [
      ['Hall', image],
      ['Not a panorama', portrait],
      ['Kitchen', image],
    ] as const) {
      const presign = await user.send('post', '/api/scenes/presign', {
        tourId: tour.id,
        filename: `${name}.jpg`,
        contentType: 'image/jpeg',
        size: data.length,
      });
      await uploadToPresigned(presign.body.upload, data, 'image/jpeg');
      await user.send('post', `/api/scenes/${presign.body.scene.id}/complete`);
      ids.push(presign.body.scene.id);
    }
    for (const id of ids)
      await waitForScene(user.agent, id, (s) => s === 'ready' || s === 'failed');
    const t = await getTour(user, tour.id);
    expect(t.scenes.map((s) => s.status)).toEqual(['ready', 'failed', 'ready']);
    expect(arrows(t, 'Hall')).toEqual(['next:Kitchen']);
    expect(arrows(t, 'Kitchen')).toEqual(['back:Hall']);
    expect(arrows(t, 'Not a panorama')).toEqual([]);
  }, 120_000);

  it('validates hotspot input and ownership', async () => {
    const user = await newUser(stack.app);
    const tour = await createTour(user);
    const [a, b] = await uploadInOrder(user, tour.id, ['A', 'B']);
    const url = `/api/scenes/${a!.id}/hotspots`;
    const bad = [
      { kind: 'teleport', yaw: 0, pitch: 0, targetSceneId: b!.id },
      { kind: 'link', yaw: 'NaN', pitch: 0, targetSceneId: b!.id },
      { kind: 'link', yaw: Number.POSITIVE_INFINITY, pitch: 0, targetSceneId: b!.id },
      { kind: 'link', yaw: 200, pitch: 0, targetSceneId: b!.id },
      { kind: 'link', yaw: 0, pitch: 0, targetSceneId: 123 },
      { kind: 'link', yaw: 0, pitch: 0, targetSceneId: 'not-a-uuid' },
      { kind: 'next', yaw: 0, pitch: 0 },
      { kind: 'info', yaw: 0, pitch: 0, title: '' },
      { kind: 'link', yaw: 0, pitch: 0, targetSceneId: a!.id },
      { kind: 'link', yaw: 0, pitch: 0, targetSceneId: b!.id, extra: true },
    ];
    for (const body of bad) {
      const res = await user.send('post', url, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    // Legacy clients sending `type` still work; a missing kind means "link".
    expect(
      (await user.send('post', url, { type: 'link', yaw: 5, pitch: 0, targetSceneId: b!.id })).body
        .hotspot.kind,
    ).toBe('link');
    expect(
      (await user.send('post', url, { yaw: 6, pitch: 0, targetSceneId: b!.id })).body.hotspot.kind,
    ).toBe('link');
    // The auto-created next arrow already exists.
    expect(
      (await user.send('post', url, { kind: 'next', yaw: 1, pitch: 0, targetSceneId: b!.id }))
        .status,
    ).toBe(409);

    // Target in somebody else's tour, and someone else's scene.
    const other = await newUser(stack.app);
    const otherTour = await createTour(other, 'Other');
    const [foreign] = await uploadInOrder(other, otherTour.id, ['Foreign']);
    expect(
      (await user.send('post', url, { kind: 'link', yaw: 0, pitch: 0, targetSceneId: foreign!.id }))
        .status,
    ).toBe(400);
    expect(
      (await other.send('post', url, { kind: 'link', yaw: 0, pitch: 0, targetSceneId: b!.id }))
        .status,
    ).toBe(404);
    expect((await other.send('post', `/api/tours/${tour.id}/link-in-order`, {})).status).toBe(404);
    expect((await other.send('delete', `/api/scenes/${a!.id}?relink=1`)).status).toBe(404);

    // Max hotspots per scene.
    const current = (await getTour(user, tour.id)).scenes[0]!.hotspots.length;
    for (let i = current; i < MAX_HOTSPOTS_PER_SCENE; i++) {
      const res = await user.send('post', url, {
        kind: 'info',
        yaw: i - 90,
        pitch: 30,
        title: `#${i}`,
      });
      expect(res.status).toBe(201);
    }
    expect(
      (await user.send('post', url, { kind: 'info', yaw: 0, pitch: 0, title: 'one too many' }))
        .status,
    ).toBe(400);
  }, 150_000);
});
