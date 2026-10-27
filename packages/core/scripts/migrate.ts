import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb } from '../src/db/client.js';
import { loadEnvFiles } from '../src/env.js';

const here = dirname(fileURLToPath(import.meta.url));
// Migrations share the API's environment (DATABASE_URL).
loadEnvFiles(resolve(here, '../../../apps/api'));

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const { db, close } = createDb(url, { max: 1 });
try {
  await migrate(db, { migrationsFolder: resolve(here, '../drizzle') });
  console.info('✔ database migrations applied');
} catch (err) {
  console.error('✖ migration failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await close();
}
