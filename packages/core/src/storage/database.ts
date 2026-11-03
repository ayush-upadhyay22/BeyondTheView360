import { createHmac, timingSafeEqual } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { storedObjects } from '../db/schema.js';
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

const UPLOAD_PATH = '/api/storage/upload';
const MEDIA_PREFIX = '/api/media/';

/**
 * Stores originals and processed variants in Postgres. For hosts that do not have
 * S3 yet (e.g. a single Oracle VM). Uploads POST back to this API; images are GET /api/media/…
 */
export class DatabaseStorageDriver implements StorageDriver {
  readonly name = 'database';

  constructor(
    private readonly db: Database,
    private readonly opts: { secret: string; publicBaseUrl?: string },
  ) {}

  async put(key: string, body: Buffer | Uint8Array, options: PutOptions): Promise<void> {
    const safe = assertSafeKey(key);
    const buf = Buffer.from(body);
    await this.db
      .insert(storedObjects)
      .values({ key: safe, contentType: options.contentType, body: buf })
      .onConflictDoUpdate({
        target: storedObjects.key,
        set: { contentType: options.contentType, body: buf, updatedAt: new Date() },
      });
  }

  async get(key: string): Promise<Buffer> {
    const [row] = await this.db
      .select({ body: storedObjects.body })
      .from(storedObjects)
      .where(eq(storedObjects.key, assertSafeKey(key)))
      .limit(1);
    if (!row) throw new StorageNotFoundError(key);
    return row.body;
  }

  async head(key: string): Promise<ObjectInfo | null> {
    const [row] = await this.db
      .select({
        contentType: storedObjects.contentType,
        size: sql<number>`octet_length(${storedObjects.body})`.mapWith(Number),
      })
      .from(storedObjects)
      .where(eq(storedObjects.key, assertSafeKey(key)))
      .limit(1);
    return row ? { size: row.size, contentType: row.contentType } : null;
  }

  async delete(keys: string | readonly string[]): Promise<void> {
    const list = (typeof keys === 'string' ? [keys] : keys).map(assertSafeKey);
    if (list.length === 0) return;
    await this.db.delete(storedObjects).where(inArray(storedObjects.key, list));
  }

  async presignUpload(options: PresignUploadOptions): Promise<PresignedUpload> {
    const key = assertSafeKey(options.key);
    const expiresAt = new Date(Date.now() + options.expiresInSeconds * 1000);
    const token = this.sign(key, expiresAt.getTime(), options.maxBytes);
    const base = this.opts.publicBaseUrl?.replace(/\/+$/, '') ?? '';
    return {
      url: `${base}${UPLOAD_PATH}`,
      fields: {
        key,
        token,
        'Content-Type': options.contentType,
        'x-max-bytes': String(options.maxBytes),
      },
      expiresAt,
    };
  }

  async publicUrl(key: string, _options: PublicUrlOptions = {}): Promise<string> {
    const base = this.opts.publicBaseUrl?.replace(/\/+$/, '') ?? '';
    return `${base}${MEDIA_PREFIX}${assertSafeKey(key)}`;
  }

  verifyUploadToken(key: string, token: string, size: number): string | null {
    const parts = token.split('.');
    if (parts.length !== 3) return 'Invalid upload token.';
    const [expRaw, maxRaw, sig] = parts;
    const expires = Number(expRaw);
    const maxBytes = Number(maxRaw);
    if (!Number.isFinite(expires) || !Number.isFinite(maxBytes) || !sig) return 'Invalid upload token.';
    if (Date.now() > expires) return 'This upload link has expired.';
    const expected = this.sign(key, expires, maxBytes);
    const a = Buffer.from(token);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return 'Invalid upload token.';
    if (size > maxBytes) return 'The uploaded file exceeds the size limit.';
    return null;
  }

  private sign(key: string, expires: number, maxBytes: number): string {
    const sig = createHmac('sha256', this.opts.secret)
      .update(`${key}\0${expires}\0${maxBytes}`)
      .digest('base64url');
    return `${expires}.${maxBytes}.${sig}`;
  }
}
