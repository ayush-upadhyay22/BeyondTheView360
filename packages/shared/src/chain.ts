import { MAX_HOTSPOTS_PER_SCENE, type HotspotKind } from './constants.js';

export interface ChainHotspot {
  id: string;
  sceneId: string;
  kind: HotspotKind;
  targetSceneId: string | null;
}

export interface ChainLink {
  sceneId: string;
  kind: 'next' | 'back';
  targetSceneId: string;
}

export interface ChainPlan {
  add: ChainLink[];
  /** Hotspot ids to delete (rebuild mode only). */
  remove: string[];
  /** Links that could not be added because the scene is at its hotspot limit. */
  skipped: ChainLink[];
}

const linkKey = (l: { sceneId: string; kind: string; targetSceneId: string | null }) =>
  `${l.sceneId}|${l.kind}|${l.targetSceneId ?? ''}`;

/** The next/back arrows that connect `orderedSceneIds` into a walk-through, in order. */
export function chainLinks(orderedSceneIds: string[]): ChainLink[] {
  const links: ChainLink[] = [];
  for (let i = 0; i + 1 < orderedSceneIds.length; i++) {
    const a = orderedSceneIds[i]!;
    const b = orderedSceneIds[i + 1]!;
    links.push({ sceneId: a, kind: 'next', targetSceneId: b });
    links.push({ sceneId: b, kind: 'back', targetSceneId: a });
  }
  return links;
}

/**
 * Works out how to make the hotspots match the chain for `orderedSceneIds`.
 * - `missing`: only adds absent next/back arrows; nothing is removed.
 * - `rebuild`: also removes next/back arrows (and duplicates) that do not match the order.
 * Custom `link` and `info` hotspots are never touched.
 */
export function planChain(
  orderedSceneIds: string[],
  hotspots: ChainHotspot[],
  mode: 'missing' | 'rebuild',
  maxPerScene = MAX_HOTSPOTS_PER_SCENE,
): ChainPlan {
  const wanted = chainLinks(orderedSceneIds);
  const wantedKeys = new Set(wanted.map(linkKey));
  const inChain = new Set(orderedSceneIds);

  const remove: string[] = [];
  const kept = new Set<string>();
  for (const h of hotspots) {
    if (h.kind !== 'next' && h.kind !== 'back') continue;
    const key = linkKey(h);
    if (kept.has(key)) {
      if (mode === 'rebuild') remove.push(h.id); // duplicate arrow
      continue;
    }
    if (mode === 'rebuild' && inChain.has(h.sceneId) && !wantedKeys.has(key)) {
      remove.push(h.id);
      continue;
    }
    kept.add(key);
  }

  const removed = new Set(remove);
  const counts = new Map<string, number>();
  for (const h of hotspots) {
    if (!removed.has(h.id)) counts.set(h.sceneId, (counts.get(h.sceneId) ?? 0) + 1);
  }

  const add: ChainLink[] = [];
  const skipped: ChainLink[] = [];
  for (const link of wanted) {
    if (kept.has(linkKey(link))) continue;
    const n = counts.get(link.sceneId) ?? 0;
    if (n >= maxPerScene) {
      skipped.push(link);
      continue;
    }
    counts.set(link.sceneId, n + 1);
    add.push(link);
  }
  return { add, remove, skipped };
}
