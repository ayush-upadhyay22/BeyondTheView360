import { describe, expect, it } from 'vitest';
import {
  angularDistance,
  normalizeYaw,
  uvToYawPitch,
  vectorToYawPitch,
  yawPitchToVector,
} from '../src/geometry.js';
import { createHotspotSchema, updateTourSchema } from '../src/schemas.js';

describe('geometry', () => {
  it('normalizes yaw into [-180, 180]', () => {
    expect(normalizeYaw(190)).toBe(-170);
    expect(normalizeYaw(-190)).toBe(170);
    expect(normalizeYaw(540)).toBe(180);
    expect(normalizeYaw(45)).toBe(45);
  });

  it('round-trips yaw/pitch through vectors', () => {
    for (const [yaw, pitch] of [
      [0, 0],
      [90, 10],
      [-135, -45],
      [179, 80],
    ] as const) {
      const v = yawPitchToVector(yaw, pitch);
      const back = vectorToYawPitch(...v);
      expect(back.yaw).toBeCloseTo(yaw, 6);
      expect(back.pitch).toBeCloseTo(pitch, 6);
    }
  });

  it('yaw 0 looks down -Z and yaw 90 looks down +X', () => {
    const [x0, , z0] = yawPitchToVector(0, 0);
    expect(z0).toBeCloseTo(-1);
    expect(x0).toBeCloseTo(0);
    const [x90] = yawPitchToVector(90, 0);
    expect(x90).toBeCloseTo(1);
  });

  it('maps the image centre to yaw 0 / pitch 0', () => {
    expect(uvToYawPitch(0.5, 0.5)).toEqual({ yaw: 0, pitch: 0 });
    expect(uvToYawPitch(0.75, 0).yaw).toBe(90);
    expect(uvToYawPitch(0.75, 0).pitch).toBe(90);
  });

  it('measures angular distance', () => {
    expect(angularDistance({ yaw: 0, pitch: 0 }, { yaw: 90, pitch: 0 })).toBeCloseTo(90);
    expect(angularDistance({ yaw: 170, pitch: 0 }, { yaw: -170, pitch: 0 })).toBeCloseTo(20);
  });
});

describe('schemas', () => {
  it('accepts link and info hotspots and rejects javascript: URLs', () => {
    expect(
      createHotspotSchema.safeParse({
        type: 'link',
        yaw: 10,
        pitch: 0,
        targetSceneId: '6a7f3a8e-3a1f-4b5e-9c55-1b2a3c4d5e6f',
      }).success,
    ).toBe(true);
    expect(
      createHotspotSchema.safeParse({ type: 'info', yaw: 0, pitch: 0, title: 'Hi' }).success,
    ).toBe(true);
    expect(
      createHotspotSchema.safeParse({
        type: 'info',
        yaw: 0,
        pitch: 0,
        title: 'x',
        imageUrl: 'javascript:alert(1)',
      }).success,
    ).toBe(false);
  });

  it('rejects unknown keys and out-of-range views', () => {
    expect(updateTourSchema.safeParse({ ownerId: 'x' }).success).toBe(false);
    expect(updateTourSchema.safeParse({ startView: { yaw: 0, pitch: 120, fov: 75 } }).success).toBe(
      false,
    );
  });
});
