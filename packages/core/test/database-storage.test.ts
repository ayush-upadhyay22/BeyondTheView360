import { describe, expect, it } from 'vitest';
import { DatabaseStorageDriver } from '../src/storage/database.js';
import type { Database } from '../src/db/client.js';

describe('DatabaseStorageDriver tokens', () => {
  const storage = new DatabaseStorageDriver({} as Database, { secret: 'test-secret' });

  it('issues a token that accepts an in-limit upload and rejects a forged one', async () => {
    const upload = await storage.presignUpload({
      key: 'originals/a/original',
      contentType: 'image/jpeg',
      maxBytes: 16,
      expiresInSeconds: 60,
    });
    expect(upload.url).toBe('/api/storage/upload');
    expect(upload.fields['Content-Type']).toBe('image/jpeg');
    expect(await storage.publicUrl('processed/a/2048.webp')).toBe('/api/media/processed/a/2048.webp');
    expect(storage.verifyUploadToken(upload.fields.key!, upload.fields.token!, 4)).toBeNull();
    expect(storage.verifyUploadToken(upload.fields.key!, '0.16.forged', 4)).toBeTruthy();
    expect(storage.verifyUploadToken(upload.fields.key!, upload.fields.token!, 99)).toBeTruthy();
  });
});
