import {
  FLOOR_PLAN_CONTENT_TYPE,
  FLOOR_PLAN_MAX_BYTES,
  FLOOR_PLAN_MAX_SIDE,
  type FloorPlanPresignResponse,
  type TourDTO,
} from '@btv/shared';
import { post } from './api';
import { isAllowedType, postToStorage } from './upload';

/**
 * Re-encodes a floor plan in the browser: at most FLOOR_PLAN_MAX_SIDE px, WebP, no metadata
 * (canvas output never carries EXIF/GPS). Transparent areas become white.
 */
export async function encodeFloorPlan(
  file: File,
): Promise<{ blob: Blob; width: number; height: number }> {
  if (!isAllowedType(file.type)) throw new Error('Use a JPEG, PNG or WebP image.');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('This image could not be read.');
  }
  const scale = Math.min(1, FLOOR_PLAN_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(16, Math.round(bitmap.width * scale));
  const height = Math.max(16, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, FLOOR_PLAN_CONTENT_TYPE, 0.9),
  );
  if (!blob || blob.type !== FLOOR_PLAN_CONTENT_TYPE) {
    throw new Error(
      'Your browser cannot prepare WebP images. Try a recent Chrome, Edge or Firefox.',
    );
  }
  if (blob.size > FLOOR_PLAN_MAX_BYTES)
    throw new Error('This floor plan is too detailed (over 5 MB).');
  return { blob, width, height };
}

export async function uploadFloorPlan(tourId: string, file: File): Promise<{ tour: TourDTO }> {
  const { blob, width, height } = await encodeFloorPlan(file);
  const { key, upload } = await post<FloorPlanPresignResponse>(
    `/tours/${tourId}/floor-plan/presign`,
    { contentType: FLOOR_PLAN_CONTENT_TYPE, size: blob.size },
  );
  await postToStorage(upload, blob, () => undefined);
  return post<{ tour: TourDTO }>(`/tours/${tourId}/floor-plan/complete`, { key, width, height });
}
