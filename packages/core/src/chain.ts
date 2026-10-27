/**
 * The walk-through chain: scenes are connected in order by a "next" arrow (straight ahead) and a
 * "back" arrow (behind) on the floor. Shared by the API (uploads, deletes, "link in order") and
 * the worker (rejected or abandoned uploads), always inside a transaction.
 */
import { and, asc, count, desc, eq, inArray, ne } from 'drizzle-orm';
import {
  BACK_ARROW_YAW,
  CHAIN_ARROW_PITCH,
  MAX_HOTSPOTS_PER_SCENE,
  NEXT_ARROW_YAW,
  planChain,
  type ChainLink,
  type LinkResultDTO,
} from '@btv/shared';
import { hotspots, scenes, tours } from './db/schema.js';
import type { Database } from './db/client.js';

export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
export type Executor = Database | Tx;

/** Serialises chain edits (and scene positions) per tour. */
export async function lockTour(tx: Tx, tourId: string): Promise<void> {
  await tx.select({ id: tours.id }).from(tours).where(eq(tours.id, tourId)).for('update');
}

const arrowPosition = (kind: ChainLink['kind']) => ({
  yaw: kind === 'next' ? NEXT_ARROW_YAW : BACK_ARROW_YAW,
  pitch: CHAIN_ARROW_PITCH,
});

/** Inserts chain arrows at their default floor positions, respecting the per-scene limit. */
export async function insertChainLinks(db: Executor, links: ChainLink[]): Promise<number> {
  if (links.length === 0) return 0;
  const sceneIds = [...new Set(links.map((l) => l.sceneId))];
  const counts = new Map(
    (
      await db
        .select({ sceneId: hotspots.sceneId, n: count() })
        .from(hotspots)
        .where(inArray(hotspots.sceneId, sceneIds))
        .groupBy(hotspots.sceneId)
    ).map((r) => [r.sceneId, r.n]),
  );
  const rows = [];
  for (const link of links) {
    const n = counts.get(link.sceneId) ?? 0;
    if (n >= MAX_HOTSPOTS_PER_SCENE) continue;
    counts.set(link.sceneId, n + 1);
    rows.push({ ...link, ...arrowPosition(link.kind), title: '' });
  }
  if (rows.length === 0) return 0;
  const inserted = await db
    .insert(hotspots)
    .values(rows)
    .onConflictDoNothing()
    .returning({ id: hotspots.id });
  return inserted.length;
}

/**
 * Links a newly added scene after the last usable scene of its tour:
 * previous --next--> new and new --back--> previous. Returns the previous scene id, if any.
 */
export async function appendToChain(
  tx: Tx,
  tourId: string,
  sceneId: string,
): Promise<string | null> {
  const [previous] = await tx
    .select({ id: scenes.id })
    .from(scenes)
    .where(and(eq(scenes.tourId, tourId), ne(scenes.id, sceneId), ne(scenes.status, 'failed')))
    .orderBy(desc(scenes.position), desc(scenes.createdAt))
    .limit(1);
  if (!previous) return null;
  await insertChainLinks(tx, [
    { sceneId: previous.id, kind: 'next', targetSceneId: sceneId },
    { sceneId, kind: 'back', targetSceneId: previous.id },
  ]);
  return previous.id;
}

/**
 * Removes every hotspot pointing at `sceneId` (and the scene's own arrows). With `bridge`, the
 * scenes before and after it are connected directly, reusing the existing arrows so positions
 * the owner dragged onto doors are kept.
 */
export async function detachFromChain(
  tx: Tx,
  sceneId: string,
  opts: { bridge: boolean },
): Promise<{ bridged: boolean }> {
  let bridged = false;
  if (opts.bridge) {
    const incoming = await tx
      .select()
      .from(hotspots)
      .where(and(eq(hotspots.targetSceneId, sceneId), eq(hotspots.kind, 'next')))
      .orderBy(asc(hotspots.createdAt));
    const outgoing = await tx
      .select()
      .from(hotspots)
      .where(and(eq(hotspots.sceneId, sceneId), eq(hotspots.kind, 'next')))
      .orderBy(asc(hotspots.createdAt));
    const prev = incoming[0];
    const next = outgoing.find((h) => h.targetSceneId && h.targetSceneId !== prev?.sceneId);
    if (prev && next?.targetSceneId) {
      const nextId = next.targetSceneId;
      const [existingNext] = await tx
        .select({ id: hotspots.id })
        .from(hotspots)
        .where(
          and(
            eq(hotspots.sceneId, prev.sceneId),
            eq(hotspots.kind, 'next'),
            eq(hotspots.targetSceneId, nextId),
          ),
        );
      if (!existingNext) {
        await tx.update(hotspots).set({ targetSceneId: nextId }).where(eq(hotspots.id, prev.id));
      }
      const [backToRemoved] = await tx
        .select({ id: hotspots.id })
        .from(hotspots)
        .where(
          and(
            eq(hotspots.sceneId, nextId),
            eq(hotspots.kind, 'back'),
            eq(hotspots.targetSceneId, sceneId),
          ),
        );
      const [existingBack] = await tx
        .select({ id: hotspots.id })
        .from(hotspots)
        .where(
          and(
            eq(hotspots.sceneId, nextId),
            eq(hotspots.kind, 'back'),
            eq(hotspots.targetSceneId, prev.sceneId),
          ),
        );
      if (!existingBack) {
        if (backToRemoved) {
          await tx
            .update(hotspots)
            .set({ targetSceneId: prev.sceneId })
            .where(eq(hotspots.id, backToRemoved.id));
        } else {
          await insertChainLinks(tx, [
            { sceneId: nextId, kind: 'back', targetSceneId: prev.sceneId },
          ]);
        }
      }
      bridged = true;
    }
  }
  await tx.delete(hotspots).where(eq(hotspots.targetSceneId, sceneId));
  await tx
    .delete(hotspots)
    .where(and(eq(hotspots.sceneId, sceneId), inArray(hotspots.kind, ['next', 'back'])));
  return { bridged };
}

/** Connects all usable scenes of a tour in their current order (see `planChain`). */
export async function linkInOrder(
  tx: Tx,
  tourId: string,
  mode: 'missing' | 'rebuild',
): Promise<LinkResultDTO> {
  const ordered = await tx
    .select({ id: scenes.id })
    .from(scenes)
    .where(and(eq(scenes.tourId, tourId), ne(scenes.status, 'failed')))
    .orderBy(asc(scenes.position), asc(scenes.createdAt));
  const ids = ordered.map((s) => s.id);
  if (ids.length === 0) return { added: 0, removed: 0 };
  const existing = await tx
    .select({
      id: hotspots.id,
      sceneId: hotspots.sceneId,
      kind: hotspots.kind,
      targetSceneId: hotspots.targetSceneId,
    })
    .from(hotspots)
    .where(inArray(hotspots.sceneId, ids))
    .orderBy(asc(hotspots.createdAt));
  const plan = planChain(ids, existing, mode);
  if (plan.remove.length) await tx.delete(hotspots).where(inArray(hotspots.id, plan.remove));
  const added = await insertChainLinks(tx, plan.add);
  return { added, removed: plan.remove.length };
}
