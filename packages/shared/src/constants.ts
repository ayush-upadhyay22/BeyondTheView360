export const TOUR_VISIBILITIES = ['private', 'unlisted', 'public'] as const;
export type TourVisibility = (typeof TOUR_VISIBILITIES)[number];

export const SCENE_STATUSES = ['pending', 'queued', 'processing', 'ready', 'failed'] as const;
export type SceneStatus = (typeof SCENE_STATUSES)[number];

/**
 * - next / back: the walk-through chain (floor arrows, created automatically in upload order)
 * - link: a custom jump to any scene (labelled pill)
 * - info: a point of interest with title, text and optional image
 */
export const HOTSPOT_KINDS = ['next', 'back', 'link', 'info'] as const;
export type HotspotKind = (typeof HOTSPOT_KINDS)[number];
export const NAVIGATION_KINDS: readonly HotspotKind[] = ['next', 'back', 'link'];
export const isNavigationKind = (kind: HotspotKind) => kind !== 'info';

/** Auto-created chain arrows sit on the floor: -0.3 rad below the horizon. */
export const CHAIN_ARROW_PITCH = -17.19;
/** "next" points straight ahead (yaw 0); "back" points behind the visitor. */
export const NEXT_ARROW_YAW = 0;
export const BACK_ARROW_YAW = 180;

export const ALLOWED_UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type AllowedUploadType = (typeof ALLOWED_UPLOAD_TYPES)[number];

/** Widths (px) of the WebP variants the worker produces, smallest first. */
export const VARIANT_WIDTHS = [1024, 2048, 4096, 8192] as const;
export const THUMBNAIL_WIDTH = 320;
export const MIN_PANORAMA_WIDTH = 2048;
export const MIN_ASPECT_RATIO = 1.9;
export const MAX_ASPECT_RATIO = 2.1;

export const MAX_HOTSPOTS_PER_SCENE = 50;

/** Floor plans are re-encoded to WebP in the browser before upload. */
export const FLOOR_PLAN_CONTENT_TYPE = 'image/webp';
export const FLOOR_PLAN_MAX_BYTES = 5 * 1024 * 1024;
export const FLOOR_PLAN_MAX_SIDE = 2048;

/** Header that every state-changing request must carry (CSRF defence, see docs/DECISIONS.md). */
export const CSRF_HEADER = 'x-btv-csrf';
export const CSRF_HEADER_VALUE = '1';

export const DEFAULT_FOV = 75;
export const MIN_FOV = 30;
export const MAX_FOV = 100;
