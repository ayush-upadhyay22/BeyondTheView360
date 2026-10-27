import { ALLOWED_UPLOAD_TYPES, type PresignUploadResponse, type SceneDTO } from '@btv/shared';
import { ApiError, post } from './api';

export type AllowedType = (typeof ALLOWED_UPLOAD_TYPES)[number];

export function isAllowedType(type: string): type is AllowedType {
  return (ALLOWED_UPLOAD_TYPES as readonly string[]).includes(type);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/** Client-side pre-checks; the worker re-validates everything from the actual bytes. */
export function precheckFile(file: File, maxBytes: number): string | null {
  if (!isAllowedType(file.type)) return 'Only JPEG, PNG or WebP images are supported.';
  if (file.size > maxBytes) {
    return `File is ${formatBytes(file.size)}; the limit is ${formatBytes(maxBytes)}.`;
  }
  return null;
}

function postToStorage(
  upload: PresignUploadResponse['upload'],
  file: File,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(upload.fields)) form.append(k, v);
    form.append('file', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', upload.url);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Storage rejected the upload (HTTP ${xhr.status}).`));
    xhr.onerror = () => reject(new Error('Upload failed. Check your connection and try again.'));
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(form);
  });
}

export function presignUpload(tourId: string, file: File): Promise<PresignUploadResponse> {
  if (!isAllowedType(file.type)) {
    return Promise.reject(new Error('Only JPEG, PNG or WebP images are supported.'));
  }
  return post<PresignUploadResponse>('/scenes/presign', {
    tourId,
    filename: file.name,
    contentType: file.type,
    size: file.size,
  });
}

/**
 * presign → direct browser-to-storage POST → complete (queues processing).
 * Pass `presigned` to reuse a presign issued earlier (the uploader presigns in drop order so
 * scene positions match the order files were added).
 */
export async function uploadPanorama(
  tourId: string,
  file: File,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
  presigned?: Promise<PresignUploadResponse>,
): Promise<SceneDTO> {
  const { scene, upload } = await (presigned ?? presignUpload(tourId, file));
  await postToStorage(upload, file, onProgress, signal);
  try {
    return (await post<{ scene: SceneDTO }>(`/scenes/${scene.id}/complete`)).scene;
  } catch (err) {
    if (err instanceof ApiError && err.code === 'upload_missing') {
      throw new Error('The upload did not reach storage. Please try again.');
    }
    throw err;
  }
}
