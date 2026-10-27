import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
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

export interface S3DriverConfig {
  bucket: string;
  region: string;
  /** Custom endpoint for S3-compatible services (MinIO). Omit for AWS. */
  endpoint?: string;
  /** Endpoint browsers use, if different from `endpoint` (e.g. API inside Docker). */
  publicEndpoint?: string;
  forcePathStyle: boolean;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** CDN / public base URL. When set, `publicUrl` returns `${publicBaseUrl}/${key}`. */
  publicBaseUrl?: string;
  signedUrlTtlSeconds: number;
}

function isNotFound(err: unknown): boolean {
  if (err instanceof S3ServiceException) {
    return (
      err.name === 'NotFound' || err.name === 'NoSuchKey' || err.$metadata.httpStatusCode === 404
    );
  }
  return false;
}

export class S3StorageDriver implements StorageDriver {
  readonly name = 's3';
  private readonly client: S3Client;
  /** Client whose endpoint is reachable from browsers; only used for signing. */
  private readonly signer: S3Client;

  constructor(private readonly config: S3DriverConfig) {
    const base: S3ClientConfig = {
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      ...(config.accessKeyId && config.secretAccessKey
        ? {
            credentials: {
              accessKeyId: config.accessKeyId,
              secretAccessKey: config.secretAccessKey,
            },
          }
        : {}),
      // Some S3-compatible stores reject the SDK's newer default checksum headers.
      ...(config.endpoint
        ? {
            requestChecksumCalculation: 'WHEN_REQUIRED' as const,
            responseChecksumValidation: 'WHEN_REQUIRED' as const,
          }
        : {}),
    };
    this.client = new S3Client({
      ...base,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    });
    const signEndpoint = config.publicEndpoint ?? config.endpoint;
    this.signer =
      signEndpoint === config.endpoint
        ? this.client
        : new S3Client({ ...base, ...(signEndpoint ? { endpoint: signEndpoint } : {}) });
  }

  async put(key: string, body: Buffer | Uint8Array, options: PutOptions): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: assertSafeKey(key),
        Body: body,
        ContentType: options.contentType,
        ...(options.cacheControl ? { CacheControl: options.cacheControl } : {}),
      }),
    );
  }

  async get(key: string): Promise<Buffer> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: assertSafeKey(key) }),
      );
      if (!res.Body) throw new StorageNotFoundError(key);
      return Buffer.from(await res.Body.transformToByteArray());
    } catch (err) {
      if (isNotFound(err)) throw new StorageNotFoundError(key);
      throw err;
    }
  }

  async head(key: string): Promise<ObjectInfo | null> {
    try {
      const res = await this.client.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: assertSafeKey(key) }),
      );
      return {
        size: res.ContentLength ?? 0,
        ...(res.ContentType ? { contentType: res.ContentType } : {}),
        ...(res.ETag ? { etag: res.ETag } : {}),
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async delete(keys: string | readonly string[]): Promise<void> {
    const list = (typeof keys === 'string' ? [keys] : [...keys]).map(assertSafeKey);
    for (let i = 0; i < list.length; i += 1000) {
      const chunk = list.slice(i, i + 1000);
      if (!chunk.length) continue;
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.config.bucket,
          Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
        }),
      );
    }
  }

  async presignUpload(options: PresignUploadOptions): Promise<PresignedUpload> {
    const key = assertSafeKey(options.key);
    const { url, fields } = await createPresignedPost(this.signer, {
      Bucket: this.config.bucket,
      Key: key,
      Conditions: [
        ['content-length-range', options.minBytes ?? 1, options.maxBytes],
        ['eq', '$Content-Type', options.contentType],
      ],
      Fields: { 'Content-Type': options.contentType },
      Expires: options.expiresInSeconds,
    });
    return { url, fields, expiresAt: new Date(Date.now() + options.expiresInSeconds * 1000) };
  }

  async publicUrl(key: string, options: PublicUrlOptions = {}): Promise<string> {
    assertSafeKey(key);
    if (this.config.publicBaseUrl) {
      return `${this.config.publicBaseUrl}/${key.split('/').map(encodeURIComponent).join('/')}`;
    }
    const ttl = options.expiresInSeconds ?? this.config.signedUrlTtlSeconds;
    return getSignedUrl(
      this.signer,
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
      { expiresIn: ttl, signingDate: stableSigningDate(ttl) },
    );
  }
}

/**
 * Signing time rounded down to half the TTL. URLs for the same object are then identical for a
 * while, so browsers (and the viewer's texture cache) can reuse them, and every URL handed out
 * still has at least TTL/2 of validity left.
 */
export function stableSigningDate(ttlSeconds: number, now = Date.now()): Date {
  const windowMs = Math.max(1, Math.floor(ttlSeconds / 2)) * 1000;
  return new Date(Math.floor(now / windowMs) * windowMs);
}
