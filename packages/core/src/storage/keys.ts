/** Object key layout. Keys never contain user-supplied text. */
export const storageKeys = {
  original: (sceneId: string) => `originals/${sceneId}/original`,
  processedPrefix: (sceneId: string) => `processed/${sceneId}/`,
  variant: (sceneId: string, width: number) => `processed/${sceneId}/${width}.webp`,
  thumbnail: (sceneId: string) => `processed/${sceneId}/thumb.jpg`,
  placeholder: (sceneId: string) => `processed/${sceneId}/placeholder.webp`,
  /** Under processed/ so the same CDN rule serves it; a new upload always gets a new key. */
  floorPlan: (tourId: string, fileId: string) => `processed/plans/${tourId}/${fileId}.webp`,
};

export function isFloorPlanKeyOf(tourId: string, key: string): boolean {
  return new RegExp(`^processed/plans/${tourId}/[A-Za-z0-9_-]{8,32}\\.webp$`).test(key);
}

/** Every object that may exist for a scene (used when deleting it). */
export function allSceneKeys(scene: { id: string; variants: readonly number[] }): string[] {
  return [
    storageKeys.original(scene.id),
    storageKeys.thumbnail(scene.id),
    storageKeys.placeholder(scene.id),
    ...[1024, 2048, 4096, 8192, ...scene.variants]
      .filter((w, i, all) => all.indexOf(w) === i)
      .map((w) => storageKeys.variant(scene.id, w)),
  ];
}

/** Long-lived caching is safe: processed objects are immutable (new upload = new scene id). */
export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
