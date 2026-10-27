import { eq } from 'drizzle-orm';
import {
  hotspots,
  scenes,
  tours,
  type Database,
  type HotspotRow,
  type SceneRow,
  type TourRow,
} from '@btv/core';
import type { TourVisibility } from '@btv/shared';
import { notFound } from '../errors.js';

/**
 * Core ownership rule: the resource must exist and belong to the user.
 * Anything else is reported as "not found" (see DECISIONS D13).
 */
export function assertOwnership<T extends { ownerId: string }>(
  resource: T | undefined | null,
  userId: string,
  what = 'Resource',
): T {
  if (!resource || resource.ownerId !== userId) throw notFound(what);
  return resource;
}

/** Whether a tour can be shown on the public page / embed to this viewer. */
export function canViewTour(
  tour: { ownerId: string; visibility: TourVisibility },
  viewerId: string | undefined,
): boolean {
  return tour.visibility !== 'private' || (viewerId !== undefined && tour.ownerId === viewerId);
}

export async function loadOwnedTour(db: Database, tourId: string, userId: string) {
  const [tour] = await db.select().from(tours).where(eq(tours.id, tourId)).limit(1);
  return assertOwnership(tour, userId, 'Tour');
}

export async function loadOwnedScene(
  db: Database,
  sceneId: string,
  userId: string,
): Promise<{ scene: SceneRow; tour: TourRow }> {
  const [row] = await db
    .select({ scene: scenes, tour: tours })
    .from(scenes)
    .innerJoin(tours, eq(tours.id, scenes.tourId))
    .where(eq(scenes.id, sceneId))
    .limit(1);
  assertOwnership(row?.tour, userId, 'Scene');
  return row as { scene: SceneRow; tour: TourRow };
}

export async function loadOwnedHotspot(
  db: Database,
  hotspotId: string,
  userId: string,
): Promise<{ hotspot: HotspotRow; scene: SceneRow; tour: TourRow }> {
  const [row] = await db
    .select({ hotspot: hotspots, scene: scenes, tour: tours })
    .from(hotspots)
    .innerJoin(scenes, eq(scenes.id, hotspots.sceneId))
    .innerJoin(tours, eq(tours.id, scenes.tourId))
    .where(eq(hotspots.id, hotspotId))
    .limit(1);
  assertOwnership(row?.tour, userId, 'Hotspot');
  return row as { hotspot: HotspotRow; scene: SceneRow; tour: TourRow };
}
