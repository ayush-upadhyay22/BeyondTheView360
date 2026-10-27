import {
  assertSafeKey,
  StorageNotFoundError,
  type ObjectInfo,
  type PresignedUpload,
  type PresignUploadOptions,
  type PublicUrlOptions,
  type PutOptions,
  type StorageDriver,
} from './types.js';

interface StoredObject {
  body: Buffer;
  contentType: string;
}

/**
 * In-process driver for unit tests and experiments. Not for production: data lives in memory
 * and presigned uploads cannot be used by a real browser.
 */
export class MemoryStorageDriver implements StorageDriver {
  readonly name = 'memory';
  readonly objects = new Map<string, StoredObject>();

  constructor(private readonly opts: { publicBaseUrl?: string } = {}) {}

  async put(key: string, body: Buffer | Uint8Array, options: PutOptions): Promise<void> {
    this.objects.set(assertSafeKey(key), {
      body: Buffer.from(body),
      contentType: options.contentType,
    });
  }

  async get(key: string): Promise<Buffer> {
    const obj = this.objects.get(assertSafeKey(key));
    if (!obj) throw new StorageNotFoundError(key);
    return Buffer.from(obj.body);
  }

  async head(key: string): Promise<ObjectInfo | null> {
    const obj = this.objects.get(assertSafeKey(key));
    return obj ? { size: obj.body.length, contentType: obj.contentType } : null;
  }

  async delete(keys: string | readonly string[]): Promise<void> {
    for (const key of typeof keys === 'string' ? [keys] : keys) {
      this.objects.delete(assertSafeKey(key));
    }
  }

  async presignUpload(options: PresignUploadOptions): Promise<PresignedUpload> {
    return {
      url: 'memory://upload',
      fields: {
        key: assertSafeKey(options.key),
        'Content-Type': options.contentType,
        'x-max-bytes': String(options.maxBytes),
      },
      expiresAt: new Date(Date.now() + options.expiresInSeconds * 1000),
    };
  }

  async publicUrl(key: string, options: PublicUrlOptions = {}): Promise<string> {
    assertSafeKey(key);
    if (this.opts.publicBaseUrl) return `${this.opts.publicBaseUrl}/${key}`;
    return `memory://${key}?expires=${options.expiresInSeconds ?? 3600}`;
  }
}
