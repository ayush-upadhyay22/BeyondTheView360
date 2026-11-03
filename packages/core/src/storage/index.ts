import type { z } from 'zod';
import type { Database } from '../db/client.js';
import type { storageEnvSchema } from '../env.js';
import { DatabaseStorageDriver } from './database.js';
import { S3StorageDriver } from './s3.js';
import type { StorageDriver } from './types.js';

export * from './types.js';
export * from './keys.js';
export { S3StorageDriver, stableSigningDate, type S3DriverConfig } from './s3.js';
export { MemoryStorageDriver } from './memory.js';
export { DatabaseStorageDriver } from './database.js';

export type StorageEnv = z.infer<typeof storageEnvSchema>;

/**
 * Builds the configured storage driver. MinIO vs AWS S3 is purely a matter of env vars
 * (S3_ENDPOINT / S3_FORCE_PATH_STYLE / credentials). `database` keeps blobs in Postgres
 * when there is no object store yet.
 *
 * EXTENSION POINT: add `case 'local':` here and extend the STORAGE_DRIVER enum in env.ts.
 */
export function createStorage(env: StorageEnv, deps: { db?: Database } = {}): StorageDriver {
  switch (env.STORAGE_DRIVER) {
    case 's3':
      return new S3StorageDriver({
        bucket: env.S3_BUCKET!,
        region: env.S3_REGION,
        endpoint: env.S3_ENDPOINT,
        publicEndpoint: env.S3_PUBLIC_ENDPOINT,
        forcePathStyle: env.S3_FORCE_PATH_STYLE,
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
        publicBaseUrl: env.PUBLIC_BASE_URL,
        signedUrlTtlSeconds: env.SIGNED_URL_TTL_SECONDS,
      });
    case 'database':
      if (!deps.db) throw new Error('createStorage({ db }) is required when STORAGE_DRIVER=database');
      return new DatabaseStorageDriver(deps.db, {
        secret: env.STORAGE_SECRET!,
        publicBaseUrl: env.PUBLIC_BASE_URL,
      });
    default: {
      const exhaustive: never = env.STORAGE_DRIVER;
      throw new Error(`Unknown storage driver: ${String(exhaustive)}`);
    }
  }
}
