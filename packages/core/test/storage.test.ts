import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  allSceneKeys,
  assertSafeKey,
  MemoryStorageDriver,
  S3StorageDriver,
  stableSigningDate,
  StorageNotFoundError,
  storageKeys,
  type StorageDriver,
} from '../src/storage/index.js';

/** Behaviour every driver must have. */
function storageContract(name: string, make: () => StorageDriver, enabled = true) {
  describe.skipIf(!enabled)(`storage contract: ${name}`, () => {
    const prefix = `test/${randomUUID()}`;

    it('puts, heads and gets an object', async () => {
      const s = make();
      const key = `${prefix}/hello.txt`;
      await s.put(key, Buffer.from('hello world'), { contentType: 'text/plain' });
      const info = await s.head(key);
      expect(info?.size).toBe(11);
      expect(info?.contentType).toBe('text/plain');
      expect((await s.get(key)).toString()).toBe('hello world');
    });

    it('returns null from head and throws StorageNotFoundError from get for missing keys', async () => {
      const s = make();
      expect(await s.head(`${prefix}/missing`)).toBeNull();
      await expect(s.get(`${prefix}/missing`)).rejects.toBeInstanceOf(StorageNotFoundError);
    });

    it('deletes single and multiple keys, ignoring missing ones', async () => {
      const s = make();
      const keys = [`${prefix}/a`, `${prefix}/b`, `${prefix}/c`];
      for (const k of keys) await s.put(k, Buffer.from(k), { contentType: 'text/plain' });
      await s.delete(keys[0]!);
      expect(await s.head(keys[0]!)).toBeNull();
      await s.delete([keys[1]!, keys[2]!, `${prefix}/never-existed`]);
      expect(await s.head(keys[1]!)).toBeNull();
      expect(await s.head(keys[2]!)).toBeNull();
    });

    it('creates presigned uploads with fields and an expiry', async () => {
      const s = make();
      const before = Date.now();
      const up = await s.presignUpload({
        key: `${prefix}/upload`,
        contentType: 'image/jpeg',
        maxBytes: 1024,
        expiresInSeconds: 600,
      });
      expect(up.url).toBeTruthy();
      expect(up.fields['Content-Type']).toBe('image/jpeg');
      expect(up.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 599_000);
    });

    it('rejects unsafe keys', async () => {
      const s = make();
      await expect(s.put('../etc/passwd', Buffer.from(''), { contentType: 'x' })).rejects.toThrow(
        /Unsafe/,
      );
      await expect(s.publicUrl('/absolute')).rejects.toThrow(/Unsafe/);
    });
  });
}

storageContract('memory', () => new MemoryStorageDriver());

const integration = process.env.RUN_INTEGRATION === '1';
storageContract(
  's3 (MinIO)',
  () =>
    new S3StorageDriver({
      bucket: process.env.S3_BUCKET ?? 'btv-media',
      region: 'us-east-1',
      endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
      forcePathStyle: true,
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'btvminio',
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? 'btv_minio_local_secret',
      signedUrlTtlSeconds: 3600,
    }),
  integration,
);

describe('S3StorageDriver (offline)', () => {
  const make = (extra: Partial<ConstructorParameters<typeof S3StorageDriver>[0]> = {}) =>
    new S3StorageDriver({
      bucket: 'bucket',
      region: 'us-east-1',
      endpoint: 'http://minio.internal:9000',
      forcePathStyle: true,
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'secretexample',
      signedUrlTtlSeconds: 3600,
      ...extra,
    });

  it('presigned POST policy enforces size range and content type', async () => {
    const up = await make().presignUpload({
      key: 'originals/abc/original',
      contentType: 'image/png',
      maxBytes: 5000,
      expiresInSeconds: 900,
    });
    expect(up.url).toBe('http://minio.internal:9000/bucket');
    expect(up.fields.key).toBe('originals/abc/original');
    const policy = JSON.parse(Buffer.from(up.fields.Policy!, 'base64').toString()) as {
      conditions: unknown[];
    };
    expect(policy.conditions).toContainEqual(['content-length-range', 1, 5000]);
    expect(policy.conditions).toContainEqual(['eq', '$Content-Type', 'image/png']);
  });

  it('signs URLs against the public endpoint when configured', async () => {
    const url = await make({ publicEndpoint: 'http://localhost:9000' }).publicUrl('a/b.webp');
    expect(url.startsWith('http://localhost:9000/bucket/a/b.webp?')).toBe(true);
    expect(url).toContain('X-Amz-Signature=');
    expect(url).toContain('X-Amz-Expires=3600');
  });

  it('returns stable signed URLs within a signing window', async () => {
    const s = make();
    expect(await s.publicUrl('a/b.webp')).toBe(await s.publicUrl('a/b.webp'));
  });

  it('uses the CDN base URL instead of signing when PUBLIC_BASE_URL is set', async () => {
    const url = await make({ publicBaseUrl: 'https://cdn.example.com' }).publicUrl(
      'processed/x/4096.webp',
    );
    expect(url).toBe('https://cdn.example.com/processed/x/4096.webp');
  });

  it('stableSigningDate rounds down to half the TTL', () => {
    const t = Date.UTC(2026, 0, 1, 10, 45, 0);
    expect(stableSigningDate(3600, t).toISOString()).toBe('2026-01-01T10:30:00.000Z');
  });
});

describe('storage keys', () => {
  it('builds deterministic keys without user input', () => {
    expect(storageKeys.original('s1')).toBe('originals/s1/original');
    expect(storageKeys.variant('s1', 2048)).toBe('processed/s1/2048.webp');
    expect(storageKeys.thumbnail('s1')).toBe('processed/s1/thumb.jpg');
  });

  it('lists every object of a scene for deletion', () => {
    const keys = allSceneKeys({ id: 's1', variants: [1024, 2048] });
    expect(keys).toContain('originals/s1/original');
    expect(keys).toContain('processed/s1/8192.webp');
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('assertSafeKey blocks traversal and odd characters', () => {
    expect(assertSafeKey('processed/a/1.webp')).toBe('processed/a/1.webp');
    for (const bad of ['', '/x', 'a/../b', 'a//b', 'a b', 'a?b', 'ä']) {
      expect(() => assertSafeKey(bad)).toThrow();
    }
  });
});
