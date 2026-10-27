export interface PutOptions {
  contentType: string;
  cacheControl?: string;
}

export interface ObjectInfo {
  size: number;
  contentType?: string;
  etag?: string;
}

export interface PresignUploadOptions {
  key: string;
  contentType: string;
  /** Inclusive upper bound enforced by the storage service (content-length-range). */
  maxBytes: number;
  minBytes?: number;
  expiresInSeconds: number;
}

/** Browser-side form upload: POST multipart/form-data with `fields` followed by `file`. */
export interface PresignedUpload {
  url: string;
  fields: Record<string, string>;
  expiresAt: Date;
}

export interface PublicUrlOptions {
  expiresInSeconds?: number;
}

/**
 * Storage abstraction used by the API and the worker.
 *
 * EXTENSION POINT: implement this interface to add drivers (local disk, database blobs, GCS,
 * Azure…) and register them in `createStorage` (./index.ts).
 */
export interface StorageDriver {
  readonly name: string;
  put(key: string, body: Buffer | Uint8Array, options: PutOptions): Promise<void>;
  /** Throws `StorageNotFoundError` when the object does not exist. */
  get(key: string): Promise<Buffer>;
  /** Returns `null` when the object does not exist. */
  head(key: string): Promise<ObjectInfo | null>;
  /** Deletes one or many objects. Missing objects are ignored. */
  delete(keys: string | readonly string[]): Promise<void>;
  presignUpload(options: PresignUploadOptions): Promise<PresignedUpload>;
  /** URL a browser can GET the object from: CDN URL if configured, otherwise a signed URL. */
  publicUrl(key: string, options?: PublicUrlOptions): Promise<string>;
}

export class StorageNotFoundError extends Error {
  constructor(readonly key: string) {
    super(`Object not found: ${key}`);
    this.name = 'StorageNotFoundError';
  }
}

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,1023}$/;

/** Rejects keys that could escape their prefix or need special encoding. */
export function assertSafeKey(key: string): string {
  if (!SAFE_KEY.test(key) || key.includes('..') || key.includes('//')) {
    throw new Error(`Unsafe storage key: ${JSON.stringify(key)}`);
  }
  return key;
}
