import { MIN_PANORAMA_WIDTH, TARGET_ASPECT_RATIO } from './constants.js';

/**
 * View coordinates used across the platform:
 * - yaw:   degrees in [-180, 180]; 0 = horizontal centre of the equirectangular image,
 *          positive = turning right.
 * - pitch: degrees in [-90, 90]; 0 = horizon, positive = looking up.
 */
const DEG = Math.PI / 180;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function normalizeYaw(yaw: number): number {
  const wrapped = ((((yaw + 180) % 360) + 360) % 360) - 180;
  // Keep +180 rather than -180 for the seam so round-trips are stable.
  return wrapped === -180 && yaw > 0 ? 180 : wrapped;
}

export function round(value: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/** Unit direction vector in a right-handed, y-up frame where yaw 0 looks down -Z. */
export function yawPitchToVector(yaw: number, pitch: number): [number, number, number] {
  const y = yaw * DEG;
  const p = pitch * DEG;
  return [Math.cos(p) * Math.sin(y), Math.sin(p), -Math.cos(p) * Math.cos(y)];
}

export function vectorToYawPitch(x: number, y: number, z: number): { yaw: number; pitch: number } {
  const len = Math.hypot(x, y, z) || 1;
  return {
    yaw: normalizeYaw(Math.atan2(x, -z) / DEG),
    pitch: clamp(Math.asin(clamp(y / len, -1, 1)) / DEG, -90, 90),
  };
}

/**
 * 2:1 canvas that can hold `width`×`height` without stretching: extra space is letterboxed.
 * Wide strips grow in height; tall landscapes grow in width. Small photos are upscaled so the
 * sphere always has at least MIN_PANORAMA_WIDTH texels.
 */
export function equirectCanvasSize(width: number, height: number): { width: number; height: number } {
  const raw = width >= height * TARGET_ASPECT_RATIO ? width : height * TARGET_ASPECT_RATIO;
  const canvasWidth = Math.max(raw, MIN_PANORAMA_WIDTH);
  const even = canvasWidth + (canvasWidth % 2);
  return { width: even, height: even / 2 };
}

/** Maps equirectangular texture coordinates (u right, v down, both 0..1) to yaw/pitch. */
export function uvToYawPitch(u: number, v: number): { yaw: number; pitch: number } {
  return { yaw: normalizeYaw((u - 0.5) * 360), pitch: (0.5 - v) * 180 };
}

/** Great-circle angle between two view directions, in degrees. */
export function angularDistance(
  a: { yaw: number; pitch: number },
  b: { yaw: number; pitch: number },
): number {
  const [ax, ay, az] = yawPitchToVector(a.yaw, a.pitch);
  const [bx, by, bz] = yawPitchToVector(b.yaw, b.pitch);
  return Math.acos(clamp(ax * bx + ay * by + az * bz, -1, 1)) / DEG;
}
