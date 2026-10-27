import { asc, eq, inArray } from 'drizzle-orm';
import {
  hotspots,
  scenes,
  storageKeys,
  type Database,
  type HotspotRow,
  type SceneRow,
  type StorageDriver,
  type TourRow,
} from '@btv/core';
import type {
  HotspotDTO,
  PublicTourDTO,
  SceneDTO,
  TourDTO,
  TourSummaryDTO,
  ViewerSceneDTO,
} from '@btv/shared';

export function hotspotToDTO(h: HotspotRow): HotspotDTO {
  return {
    id: h.id,
    sceneId: h.sceneId,
    type: h.type,
    yaw: h.yaw,
    pitch: h.pitch,
    title: h.title,
    text: h.text,
    imageUrl: h.imageUrl,
    targetSceneId: h.targetSceneId,
  };
}

async function viewerFields(
  storage: StorageDriver,
  scene: SceneRow,
  sceneHotspots: HotspotRow[],
): Promise<ViewerSceneDTO> {
  const ready = scene.status === 'ready';
  const variants = ready
    ? await Promise.all(
        [...scene.variants]
          .sort((a, b) => a - b)
          .map(async (width) => ({
            width,
            url: await storage.publicUrl(storageKeys.variant(scene.id, width)),
          })),
      )
    : [];
  return {
    id: scene.id,
    name: scene.name,
    width: scene.width,
    height: scene.height,
    northOffset: scene.northOffset,
    startView: scene.startView ?? null,
    placeholder: ready ? scene.placeholder : null,
    thumbUrl: ready && scene.thumbKey ? await storage.publicUrl(scene.thumbKey) : null,
    variants,
    hotspots: sceneHotspots.map(hotspotToDTO),
  };
}

export async function sceneToDTO(
  storage: StorageDriver,
  scene: SceneRow,
  sceneHotspots: HotspotRow[],
): Promise<SceneDTO> {
  return {
    ...(await viewerFields(storage, scene, sceneHotspots)),
    tourId: scene.tourId,
    position: scene.position,
    status: scene.status,
    progress: scene.progress,
    error: scene.error,
    sizeBytes: scene.sizeBytes,
    createdAt: scene.createdAt.toISOString(),
    updatedAt: scene.updatedAt.toISOString(),
  };
}

export async function loadTourScenes(db: Database, tourId: string) {
  const sceneRows = await db
    .select()
    .from(scenes)
    .where(eq(scenes.tourId, tourId))
    .orderBy(asc(scenes.position), asc(scenes.createdAt));
  const hotspotRows = sceneRows.length
    ? await db
        .select()
        .from(hotspots)
        .where(
          inArray(
            hotspots.sceneId,
            sceneRows.map((s) => s.id),
          ),
        )
        .orderBy(asc(hotspots.createdAt))
    : [];
  const bySceneId = new Map<string, HotspotRow[]>();
  for (const h of hotspotRows) {
    const list = bySceneId.get(h.sceneId) ?? [];
    list.push(h);
    bySceneId.set(h.sceneId, list);
  }
  return sceneRows.map((scene) => ({ scene, hotspots: bySceneId.get(scene.id) ?? [] }));
}

export async function sceneWithHotspotsToDTO(
  db: Database,
  storage: StorageDriver,
  scene: SceneRow,
): Promise<SceneDTO> {
  const rows = await db
    .select()
    .from(hotspots)
    .where(eq(hotspots.sceneId, scene.id))
    .orderBy(asc(hotspots.createdAt));
  return sceneToDTO(storage, scene, rows);
}

/** Thumbnail of the start scene, or of the first ready scene. */
function pickCover(tour: TourRow, list: SceneRow[]): SceneRow | undefined {
  const ready = list.filter((s) => s.status === 'ready' && s.thumbKey);
  return ready.find((s) => s.id === tour.startSceneId) ?? ready[0];
}

export async function tourSummaryToDTO(
  storage: StorageDriver,
  tour: TourRow,
  tourScenes: SceneRow[],
): Promise<TourSummaryDTO> {
  const cover = pickCover(tour, tourScenes);
  return {
    id: tour.id,
    shareId: tour.shareId,
    title: tour.title,
    visibility: tour.visibility,
    sceneCount: tourScenes.length,
    viewCount: tour.viewCount,
    thumbnailUrl: cover?.thumbKey ? await storage.publicUrl(cover.thumbKey) : null,
    createdAt: tour.createdAt.toISOString(),
    updatedAt: tour.updatedAt.toISOString(),
  };
}

export async function tourToDTO(
  db: Database,
  storage: StorageDriver,
  tour: TourRow,
): Promise<TourDTO> {
  const rows = await loadTourScenes(db, tour.id);
  const summary = await tourSummaryToDTO(
    storage,
    tour,
    rows.map((r) => r.scene),
  );
  return {
    ...summary,
    description: tour.description,
    startSceneId: tour.startSceneId,
    startView: tour.startView ?? null,
    scenes: await Promise.all(rows.map((r) => sceneToDTO(storage, r.scene, r.hotspots))),
  };
}

/** Public projection: only ready scenes, and only links between ready scenes. */
export async function publicTourToDTO(
  db: Database,
  storage: StorageDriver,
  tour: TourRow,
): Promise<PublicTourDTO> {
  const rows = (await loadTourScenes(db, tour.id)).filter((r) => r.scene.status === 'ready');
  const readyIds = new Set(rows.map((r) => r.scene.id));
  const viewerScenes = await Promise.all(
    rows.map((r) =>
      viewerFields(
        storage,
        r.scene,
        r.hotspots.filter((h) => h.type !== 'link' || readyIds.has(h.targetSceneId ?? '')),
      ),
    ),
  );
  return {
    shareId: tour.shareId,
    title: tour.title,
    description: tour.description,
    visibility: tour.visibility,
    startSceneId:
      tour.startSceneId && readyIds.has(tour.startSceneId)
        ? tour.startSceneId
        : (viewerScenes[0]?.id ?? null),
    startView: tour.startView ?? null,
    scenes: viewerScenes,
  };
}
