import { MIN_FOV } from './constants.js';
import { clamp, normalizeYaw } from './geometry.js';
import type { View } from './schemas.js';

/** Turn + zoom + fade to black before the scene swap. */
export const WALK_OUT_MS = 450;
/** Fade back in (and restore the field of view) after the swap. */
export const WALK_IN_MS = 320;
/** Reduced-motion walks are a plain fade, no turn or zoom. */
export const WALK_FADE_MS = 200;
/** Degrees the field of view narrows while "stepping forward". */
export const WALK_FOV_ZOOM = 22;
/** -0.1 rad: the camera dips slightly toward the floor while walking. */
export const WALK_PITCH = -5.73;
/** Guided walk: time spent in each scene before walking on. */
export const GUIDED_DWELL_MS = 3500;
/** Guided walk autorotate speed, degrees per second. */
export const GUIDED_ROTATE_SPEED = 4;

export interface WalkPose {
  yaw: number;
  pitch: number;
  fov: number;
  /** Black overlay opacity, 0..1. */
  overlay: number;
}

/** Signed shortest rotation from `from` to `to`, in (-180, 180]. */
export function shortestYawDelta(from: number, to: number): number {
  const d = normalizeYaw(to - from);
  return d === -180 ? 180 : d;
}

export const easeInOutCubic = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
export const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

export function walkOutDuration(reducedMotion: boolean): number {
  return reducedMotion ? WALK_FADE_MS : WALK_OUT_MS;
}

export function walkInDuration(reducedMotion: boolean): number {
  return reducedMotion ? WALK_FADE_MS : WALK_IN_MS;
}

export function zoomedFov(fov: number): number {
  return Math.max(MIN_FOV, fov - WALK_FOV_ZOOM);
}

/** Pose `elapsedMs` into the walk-out phase, turning from `from` toward `towardYaw`. */
export function walkOutPose(
  elapsedMs: number,
  from: View,
  towardYaw: number,
  reducedMotion: boolean,
): WalkPose {
  const p = clamp(elapsedMs / walkOutDuration(reducedMotion), 0, 1);
  if (reducedMotion) return { ...from, overlay: p };
  const e = easeInOutCubic(p);
  return {
    yaw: normalizeYaw(from.yaw + shortestYawDelta(from.yaw, towardYaw) * e),
    pitch: from.pitch + (WALK_PITCH - from.pitch) * e,
    fov: from.fov + (zoomedFov(from.fov) - from.fov) * e,
    // Ease-in: the turn stays visible, the screen is black by the end.
    overlay: p * p,
  };
}

/** Pose `elapsedMs` into the walk-in phase, arriving at `arrival`. */
export function walkInPose(elapsedMs: number, arrival: View, reducedMotion: boolean): WalkPose {
  const p = clamp(elapsedMs / walkInDuration(reducedMotion), 0, 1);
  if (reducedMotion) return { ...arrival, overlay: 1 - p };
  const e = easeOutCubic(p);
  const startFov = zoomedFov(arrival.fov);
  return {
    yaw: arrival.yaw,
    pitch: WALK_PITCH + (arrival.pitch - WALK_PITCH) * e,
    fov: startFov + (arrival.fov - startFov) * e,
    overlay: 1 - e,
  };
}

/**
 * Yaw to face after walking along `walkYaw`: the same compass heading in the next scene.
 * With uncalibrated scenes (north offsets 0) that is simply the same yaw.
 */
export function arrivalYaw(walkYaw: number, fromNorthOffset: number, toNorthOffset: number) {
  return normalizeYaw(walkYaw - fromNorthOffset + toNorthOffset);
}
