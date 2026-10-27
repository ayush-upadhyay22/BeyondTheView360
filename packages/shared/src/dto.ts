import type { HotspotType, SceneStatus, TourVisibility } from './constants.js';
import type { View } from './schemas.js';

export interface PlanLimits {
  maxTours: number;
  maxScenesPerTour: number;
  maxUploadBytes: number;
}

export interface UserDTO {
  id: string;
  email: string;
  plan: string;
  limits: PlanLimits;
  createdAt: string;
}

export interface VariantDTO {
  width: number;
  url: string;
}

export interface HotspotDTO {
  id: string;
  sceneId: string;
  type: HotspotType;
  yaw: number;
  pitch: number;
  title: string;
  text: string;
  imageUrl: string | null;
  targetSceneId: string | null;
}

/** The subset of scene data the viewer needs. Shared by editor, public page and embed. */
export interface ViewerSceneDTO {
  id: string;
  name: string;
  width: number | null;
  height: number | null;
  northOffset: number;
  startView: View | null;
  placeholder: string | null;
  thumbUrl: string | null;
  variants: VariantDTO[];
  hotspots: HotspotDTO[];
}

export interface SceneDTO extends ViewerSceneDTO {
  tourId: string;
  position: number;
  status: SceneStatus;
  progress: number;
  error: string | null;
  sizeBytes: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface TourSummaryDTO {
  id: string;
  shareId: string;
  title: string;
  visibility: TourVisibility;
  sceneCount: number;
  viewCount: number;
  thumbnailUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

// EXTENSION POINT (floor plans): add `floorPlan?: { imageUrl; markers: { sceneId; x; y }[] }`
// here and to PublicTourDTO; the viewer would render it as an overlay that calls goTo().
export interface TourDTO extends TourSummaryDTO {
  description: string;
  startSceneId: string | null;
  startView: View | null;
  scenes: SceneDTO[];
}

export interface PublicTourDTO {
  shareId: string;
  title: string;
  description: string;
  visibility: TourVisibility;
  startSceneId: string | null;
  startView: View | null;
  scenes: ViewerSceneDTO[];
}

export interface PresignUploadResponse {
  scene: SceneDTO;
  upload: {
    url: string;
    fields: Record<string, string>;
    maxBytes: number;
    expiresAt: string;
  };
}

export interface TourStatsDTO {
  tourId: string;
  total: number;
  daily: { day: string; count: number }[];
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}
