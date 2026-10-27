import type { HotspotKind, SceneStatus, TourVisibility } from './constants.js';
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
  kind: HotspotKind;
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
  /** Floor-plan pin (0..1 of the plan's width/height), or null when not placed. */
  mapX: number | null;
  mapY: number | null;
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

export interface FloorPlanDTO {
  url: string;
  width: number;
  height: number;
}

export interface TourDTO extends TourSummaryDTO {
  description: string;
  startSceneId: string | null;
  startView: View | null;
  floorPlan: FloorPlanDTO | null;
  scenes: SceneDTO[];
}

export interface PublicTourDTO {
  shareId: string;
  title: string;
  description: string;
  visibility: TourVisibility;
  startSceneId: string | null;
  startView: View | null;
  floorPlan: FloorPlanDTO | null;
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

export interface LinkResultDTO {
  added: number;
  removed: number;
}

export interface FloorPlanPresignResponse {
  key: string;
  upload: PresignUploadResponse['upload'];
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
