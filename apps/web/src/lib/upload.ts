import {
  ALLOWED_UPLOAD_TYPES,
  UPLOAD_CHUNK_BYTES,
  type PresignUploadResponse,
  type SceneDTO,
} from '@btv/shared';
import { ApiError, del, post } from './api';

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

function isApiStorageUrl(url: string): boolean {
  return url.includes('/storage/upload');
}

class StorageUploadError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status = 0,
  ) {
    super(message);
    this.name = 'StorageUploadError';
  }
}

function errorFromXhr(xhr: XMLHttpRequest): StorageUploadError {
  try {
    const data = JSON.parse(xhr.responseText) as {
      error?: { code?: string; message?: string };
    };
    if (data.error?.code === 'upload_restart') {
      return new StorageUploadError(
        data.error.message ?? 'The upload session expired.',
        'upload_restart',
        xhr.status,
      );
    }
    if (data.error?.message) {
      return new StorageUploadError(data.error.message, data.error.code, xhr.status);
    }
  } catch {
    /* ignore non-JSON */
  }
  if (xhr.status === 413) {
    return new StorageUploadError('This file is too large to upload.', 'file_too_large', 413);
  }
  if (xhr.status === 0) {
    return new StorageUploadError(
      'The upload timed out. Try a 4K export or a stronger connection.',
      'timeout',
    );
  }
  return new StorageUploadError(
    `Storage rejected the upload (HTTP ${xhr.status}).`,
    undefined,
    xhr.status,
  );
}

function postForm(
  url: string,
  form: FormData,
  onProgress: (fraction: number) => void,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.timeout = timeoutMs;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(errorFromXhr(xhr));
    xhr.onerror = () =>
      reject(new StorageUploadError('Upload failed. Check your connection and try again.'));
    xhr.ontimeout = () =>
      reject(
        new StorageUploadError(
          'The upload timed out. Try a 4K export or a stronger connection.',
        ),
      );
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
    const onAbort = () => xhr.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    xhr.send(form);
  });
}

function buildForm(
  fields: Record<string, string>,
  file: Blob,
  extra: Record<string, string> = {},
): FormData {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  form.append('file', file);
  return form;
}

async function postChunked(
  upload: PresignUploadResponse['upload'],
  file: Blob,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const total = Math.max(1, Math.ceil(file.size / UPLOAD_CHUNK_BYTES));
  let restart = 0;
  for (let i = 0; i < total; ) {
    const start = i * UPLOAD_CHUNK_BYTES;
    const part = file.slice(start, Math.min(file.size, start + UPLOAD_CHUNK_BYTES));
    const form = buildForm(upload.fields, part, {
      chunkIndex: String(i),
      chunkTotal: String(total),
      size: String(file.size),
    });
    try {
      await postForm(
        upload.url,
        form,
        (frac) => onProgress((i + frac) / total),
        signal,
        90_000,
      );
      i += 1;
    } catch (err) {
      if (signal?.aborted) throw err;
      if (err instanceof StorageUploadError && err.code === 'upload_restart') {
        restart += 1;
        if (restart > 2) throw err;
        i = 0;
        continue;
      }
      const retryable =
        err instanceof StorageUploadError &&
        (err.status === 0 || err.status >= 500 || err.code === 'timeout');
      if (retryable && restart < 3) {
        restart += 1;
        await new Promise((r) => setTimeout(r, 800 * restart));
        continue;
      }
      throw err;
    }
  }
}

export async function postToStorage(
  upload: PresignUploadResponse['upload'],
  file: Blob,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (isApiStorageUrl(upload.url) && file.size > UPLOAD_CHUNK_BYTES) {
    await postChunked(upload, file, onProgress, signal);
    return;
  }
  await postForm(
    upload.url,
    buildForm(upload.fields, file, { size: String(file.size) }),
    onProgress,
    signal,
    5 * 60_000,
  );
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
  try {
    await postToStorage(upload, file, (p) => onProgress(Math.min(0.97, p * 0.97)), signal);
    onProgress(0.98);
  } catch (err) {
    // The scene was already reserved and linked into the walk-through: remove it and reconnect
    // its neighbours so a cancelled upload doesn't leave a gap.
    await del(`/scenes/${scene.id}?relink=1`).catch(() => undefined);
    throw err;
  }
  try {
    const done = (await post<{ scene: SceneDTO }>(`/scenes/${scene.id}/complete`)).scene;
    onProgress(1);
    return done;
  } catch (err) {
    if (err instanceof ApiError && err.code === 'upload_missing') {
      throw new Error('The upload did not reach storage. Please try again.');
    }
    throw err;
  }
}
