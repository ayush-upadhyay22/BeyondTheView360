import { normalizeYaw } from './geometry.js';

/** A floor-plan pin: x and y as fractions (0..1) of the plan's width and height, y downward. */
export interface PlanPin {
  id: string;
  x: number;
  y: number;
}

/**
 * Compass bearing from `from` to `to` on the plan, in degrees clockwise from "up" (plan north),
 * in (-180, 180]. `aspect` = plan width / height, so distances are measured in real proportions.
 */
export function planBearing(
  from: { x: number; y: number },
  to: { x: number; y: number },
  aspect: number,
): number {
  const dx = (to.x - from.x) * aspect;
  const dy = to.y - from.y;
  const deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
  const yaw = normalizeYaw(deg);
  return yaw === -180 ? 180 : yaw;
}

/** Scene yaw that looks along a plan bearing, given the yaw at which the scene faces north. */
export function bearingToYaw(bearing: number, northOffset: number): number {
  return normalizeYaw(northOffset + bearing);
}

/** Plan bearing the camera is facing, for the mini-map view cone. */
export function yawToBearing(yaw: number, northOffset: number): number {
  return normalizeYaw(yaw - northOffset);
}

export function planDistance(
  a: { x: number; y: number },
  b: { x: number; y: number },
  aspect: number,
): number {
  return Math.hypot((b.x - a.x) * aspect, b.y - a.y);
}

/** The `k` nearest other pins of every pin, closest first (ties broken by id for stability). */
export function nearestNeighbors(pins: PlanPin[], k: number, aspect: number) {
  const result = new Map<string, string[]>();
  for (const pin of pins) {
    const others = pins
      .filter((p) => p.id !== pin.id)
      .map((p) => ({ id: p.id, d: planDistance(pin, p, aspect) }))
      .sort((a, b) => a.d - b.d || a.id.localeCompare(b.id));
    result.set(
      pin.id,
      others.slice(0, Math.max(0, k)).map((o) => o.id),
    );
  }
  return result;
}

/** Unordered pairs connecting every pin to its `k` nearest neighbours, without duplicates. */
export function neighborPairs(pins: PlanPin[], k: number, aspect: number): [string, string][] {
  const seen = new Set<string>();
  const pairs: [string, string][] = [];
  for (const [id, neighbors] of nearestNeighbors(pins, k, aspect)) {
    for (const other of neighbors) {
      const [a, b] = id < other ? [id, other] : [other, id];
      const key = `${a}|${b}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push([a, b]);
    }
  }
  return pairs;
}
