export const TOUR_VISIBILITIES = ['private', 'unlisted', 'public'] as const;
export type TourVisibility = (typeof TOUR_VISIBILITIES)[number];

export const SCENE_STATUSES = ['pending', 'queued', 'processing', 'ready', 'failed'] as const;
export type SceneStatus = (typeof SCENE_STATUSES)[number];

export const HOTSPOT_TYPES = ['link', 'info'] as const;
export type HotspotType = (typeof HOTSPOT_TYPES)[number];

export const ALLOWED_UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type AllowedUploadType = (typeof ALLOWED_UPLOAD_TYPES)[number];

/** Widths (px) of the WebP variants the worker produces, smallest first. */
export const VARIANT_WIDTHS = [1024, 2048, 4096, 8192] as const;
export const THUMBNAIL_WIDTH = 320;
export const MIN_PANORAMA_WIDTH = 2048;
export const MIN_ASPECT_RATIO = 1.9;
export const MAX_ASPECT_RATIO = 2.1;

export const MAX_HOTSPOTS_PER_SCENE = 100;

/** Header that every state-changing request must carry (CSRF defence, see docs/DECISIONS.md). */
export const CSRF_HEADER = 'x-btv-csrf';
export const CSRF_HEADER_VALUE = '1';

export const DEFAULT_FOV = 75;
export const MIN_FOV = 30;
export const MAX_FOV = 100;
