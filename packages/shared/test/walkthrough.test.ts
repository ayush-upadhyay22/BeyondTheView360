import { describe, expect, it } from 'vitest';
import {
  arrivalYaw,
  bearingToYaw,
  chainLinks,
  createHotspotSchema,
  MAX_HOTSPOTS_PER_SCENE,
  nearestNeighbors,
  neighborPairs,
  parseViewerParams,
  planBearing,
  planChain,
  shortestYawDelta,
  updateSceneSchema,
  viewerQuery,
  WALK_FADE_MS,
  WALK_IN_MS,
  WALK_OUT_MS,
  WALK_PITCH,
  walkInPose,
  walkOutPose,
  yawToBearing,
  zoomedFov,
  type ChainHotspot,
} from '../src/index.js';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';

describe('planChain', () => {
  const asHotspots = (links: ReturnType<typeof chainLinks>): ChainHotspot[] =>
    links.map((l, i) => ({ id: `h${i}`, ...l }));

  it('creates next/back pairs in order', () => {
    expect(chainLinks([A, B, C])).toEqual([
      { sceneId: A, kind: 'next', targetSceneId: B },
      { sceneId: B, kind: 'back', targetSceneId: A },
      { sceneId: B, kind: 'next', targetSceneId: C },
      { sceneId: C, kind: 'back', targetSceneId: B },
    ]);
    expect(chainLinks([A])).toEqual([]);
  });

  it('is idempotent: a complete chain needs no changes', () => {
    const existing = asHotspots(chainLinks([A, B, C]));
    for (const mode of ['missing', 'rebuild'] as const) {
      expect(planChain([A, B, C], existing, mode)).toEqual({ add: [], remove: [], skipped: [] });
    }
  });

  it('only adds missing arrows and never removes custom ones in "missing" mode', () => {
    const existing: ChainHotspot[] = [
      { id: 'n1', sceneId: A, kind: 'next', targetSceneId: B },
      { id: 'stale', sceneId: B, kind: 'next', targetSceneId: A },
      { id: 'custom', sceneId: A, kind: 'link', targetSceneId: C },
      { id: 'info', sceneId: B, kind: 'info', targetSceneId: null },
    ];
    const plan = planChain([A, B, C], existing, 'missing');
    expect(plan.remove).toEqual([]);
    expect(plan.add).toEqual([
      { sceneId: B, kind: 'back', targetSceneId: A },
      { sceneId: B, kind: 'next', targetSceneId: C },
      { sceneId: C, kind: 'back', targetSceneId: B },
    ]);
  });

  it('rebuild removes arrows that break the order and duplicates, keeps link/info', () => {
    const existing: ChainHotspot[] = [
      ...asHotspots(chainLinks([A, C, B])),
      { id: 'dup', sceneId: A, kind: 'next', targetSceneId: C },
      { id: 'custom', sceneId: A, kind: 'link', targetSceneId: B },
      { id: 'info', sceneId: C, kind: 'info', targetSceneId: null },
    ];
    const plan = planChain([A, B, C], existing, 'rebuild');
    // Every arrow of the old order A, C, B is wrong for A, B, C.
    expect(plan.remove.sort()).toEqual(['dup', 'h0', 'h1', 'h2', 'h3']);
    expect(plan.add).toHaveLength(4);
    expect(plan.remove).not.toContain('custom');
    expect(plan.remove).not.toContain('info');
  });

  it('respects the per-scene hotspot limit', () => {
    const full: ChainHotspot[] = Array.from({ length: MAX_HOTSPOTS_PER_SCENE }, (_, i) => ({
      id: `i${i}`,
      sceneId: A,
      kind: 'info',
      targetSceneId: null,
    }));
    const plan = planChain([A, B], full, 'missing');
    expect(plan.add).toEqual([{ sceneId: B, kind: 'back', targetSceneId: A }]);
    expect(plan.skipped).toEqual([{ sceneId: A, kind: 'next', targetSceneId: B }]);
  });
});

describe('walking transition timing', () => {
  const from = { yaw: 170, pitch: 10, fov: 75 };

  it('turns the shortest way round', () => {
    expect(shortestYawDelta(170, -170)).toBe(20);
    expect(shortestYawDelta(-170, 170)).toBe(-20);
    expect(shortestYawDelta(0, 180)).toBe(180);
    expect(shortestYawDelta(10, 10)).toBe(0);
  });

  it('starts at the current view and ends facing the arrow, zoomed, dipped and black', () => {
    expect(walkOutPose(0, from, -170, false)).toEqual({ ...from, overlay: 0 });
    const end = walkOutPose(WALK_OUT_MS, from, -170, false);
    expect(end.yaw).toBeCloseTo(-170);
    expect(end.pitch).toBeCloseTo(WALK_PITCH);
    expect(end.fov).toBe(75 - 22);
    expect(end.overlay).toBe(1);
    // Past the end it clamps.
    expect(walkOutPose(WALK_OUT_MS * 3, from, -170, false)).toEqual(end);
  });

  it('passes through the seam instead of spinning the long way', () => {
    const mid = walkOutPose(WALK_OUT_MS / 2, from, -170, false);
    expect(Math.abs(mid.yaw)).toBeGreaterThan(170);
    expect(mid.overlay).toBeGreaterThan(0);
    expect(mid.overlay).toBeLessThan(0.5);
  });

  it('fades back in while restoring the field of view', () => {
    const arrival = { yaw: -170, pitch: 0, fov: 75 };
    const start = walkInPose(0, arrival, false);
    expect(start).toMatchObject({ yaw: -170, fov: zoomedFov(75), overlay: 1 });
    expect(walkInPose(WALK_IN_MS, arrival, false)).toEqual({ ...arrival, overlay: 0 });
  });

  it('never zooms below the minimum field of view', () => {
    expect(zoomedFov(40)).toBe(30);
  });

  it('is a plain fade with reduced motion', () => {
    const half = walkOutPose(WALK_FADE_MS / 2, from, -170, true);
    expect(half).toEqual({ ...from, overlay: 0.5 });
    const arrival = { yaw: 5, pitch: 0, fov: 75 };
    expect(walkInPose(0, arrival, true)).toEqual({ ...arrival, overlay: 1 });
    expect(walkInPose(WALK_FADE_MS, arrival, true)).toEqual({ ...arrival, overlay: 0 });
  });

  it('arrives with the same compass heading', () => {
    expect(arrivalYaw(30, 0, 0)).toBe(30);
    expect(arrivalYaw(30, 10, -20)).toBe(0);
    expect(arrivalYaw(170, -20, 0)).toBe(-170);
  });
});

describe('deep-link parameters', () => {
  it('parses scene, autoplay and ui', () => {
    expect(parseViewerParams('?scene=abc-123&autoplay=1&ui=0')).toEqual({
      sceneId: 'abc-123',
      autoplay: true,
      ui: false,
    });
    expect(parseViewerParams('')).toEqual({ sceneId: null, autoplay: false, ui: true });
    expect(parseViewerParams('autoplay=true&ui=1')).toMatchObject({ autoplay: true, ui: true });
    expect(parseViewerParams('autoplay=0&ui=false')).toMatchObject({ autoplay: false, ui: false });
  });

  it('ignores malformed scene ids', () => {
    expect(parseViewerParams('?scene=<script>').sceneId).toBeNull();
    expect(parseViewerParams(`?scene=${'x'.repeat(65)}`).sceneId).toBeNull();
    expect(parseViewerParams(new URLSearchParams({ scene: ' ok ' })).sceneId).toBe('ok');
  });

  it('round-trips through viewerQuery', () => {
    const q = viewerQuery({ sceneId: 's1', autoplay: true, ui: false });
    expect(q).toBe('?scene=s1&autoplay=1&ui=0');
    expect(parseViewerParams(q)).toEqual({ sceneId: 's1', autoplay: true, ui: false });
    expect(viewerQuery({ autoplay: false, ui: true })).toBe('');
  });
});

describe('floor-plan maths', () => {
  it('measures bearings clockwise from plan north (up)', () => {
    const o = { x: 0.5, y: 0.5 };
    expect(planBearing(o, { x: 0.5, y: 0.1 }, 1)).toBe(0);
    expect(planBearing(o, { x: 0.9, y: 0.5 }, 1)).toBe(90);
    expect(planBearing(o, { x: 0.5, y: 0.9 }, 1)).toBe(180);
    expect(planBearing(o, { x: 0.1, y: 0.5 }, 1)).toBe(-90);
    expect(planBearing(o, { x: 0.6, y: 0.4 }, 1)).toBeCloseTo(45);
  });

  it('accounts for the plan aspect ratio', () => {
    // On a 2:1 plan, equal fractions right and up are twice as far right in reality.
    expect(planBearing({ x: 0.5, y: 0.5 }, { x: 0.6, y: 0.4 }, 2)).toBeCloseTo(63.43, 1);
  });

  it('converts between bearings and scene yaw with the north offset', () => {
    expect(bearingToYaw(90, 0)).toBe(90);
    expect(bearingToYaw(90, 120)).toBe(-150);
    expect(yawToBearing(bearingToYaw(37, -64), -64)).toBeCloseTo(37);
  });

  it('finds nearest neighbours and unique pairs', () => {
    const pins = [
      { id: 'hall', x: 0.1, y: 0.5 },
      { id: 'kitchen', x: 0.3, y: 0.5 },
      { id: 'bedroom', x: 0.9, y: 0.5 },
      { id: 'bath', x: 0.3, y: 0.8 },
    ];
    const nn = nearestNeighbors(pins, 1, 1);
    expect(nn.get('hall')).toEqual(['kitchen']);
    expect(nn.get('bedroom')).toEqual(['kitchen']);
    expect(nn.get('bath')).toEqual(['kitchen']);
    // hall<->kitchen is found from both ends but returned once.
    expect(neighborPairs(pins, 1, 1)).toEqual([
      ['hall', 'kitchen'],
      ['bedroom', 'kitchen'],
      ['bath', 'kitchen'],
    ]);
    expect(nearestNeighbors([pins[0]!], 2, 1).get('hall')).toEqual([]);
  });
});

describe('hotspot validation', () => {
  const base = { yaw: 0, pitch: -17, targetSceneId: A };

  it('accepts every kind and treats a missing kind as link', () => {
    for (const kind of ['next', 'back', 'link'] as const) {
      expect(createHotspotSchema.parse({ kind, ...base })).toMatchObject({ kind, title: '' });
    }
    expect(createHotspotSchema.parse(base)).toMatchObject({ kind: 'link' });
    expect(createHotspotSchema.parse({ type: 'link', ...base })).toMatchObject({ kind: 'link' });
    expect(createHotspotSchema.parse({ kind: 'info', yaw: 1, pitch: 2, title: 'Hi' })).toEqual({
      kind: 'info',
      yaw: 1,
      pitch: 2,
      title: 'Hi',
      text: '',
      imageUrl: null,
    });
  });

  it('rejects non-finite or out-of-range angles and bad targets', () => {
    const bad = [
      { kind: 'link', ...base, yaw: Number.NaN },
      { kind: 'link', ...base, yaw: Number.POSITIVE_INFINITY },
      { kind: 'link', ...base, pitch: 91 },
      { kind: 'link', ...base, yaw: '0' },
      { kind: 'next', yaw: 0, pitch: 0, targetSceneId: 42 },
      { kind: 'back', yaw: 0, pitch: 0 },
      { kind: 'portal', ...base },
      { kind: 'info', yaw: 0, pitch: 0, title: 'x', imageUrl: 'javascript:alert(1)' },
      { kind: 'link', ...base, text: 'links have no text' },
      null,
      [],
    ];
    for (const input of bad) {
      expect(createHotspotSchema.safeParse(input).success, JSON.stringify(input)).toBe(false);
    }
  });

  it('requires map pins to be set together and within 0..1', () => {
    expect(updateSceneSchema.safeParse({ mapX: 0.2, mapY: 0.4 }).success).toBe(true);
    expect(updateSceneSchema.safeParse({ mapX: null, mapY: null }).success).toBe(true);
    expect(updateSceneSchema.safeParse({ mapX: 0.2 }).success).toBe(false);
    expect(updateSceneSchema.safeParse({ mapX: 1.2, mapY: 0 }).success).toBe(false);
  });
});
