import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;

export interface DbHandle {
  db: Database;
  pool: pg.Pool;
  close: () => Promise<void>;
}

function useSsl(url: string): boolean {
  if (/localhost|127\.0\.0\.1/i.test(url)) return false;
  return (
    process.env.NODE_ENV === 'production' ||
    /render\.com|neon\.tech|sslmode=require|ssl=true/i.test(url)
  );
}

export function createDb(url: string, opts: { max?: number } = {}): DbHandle {
  const pool = new pg.Pool({
    connectionString: url,
    max: opts.max ?? 10,
    ...(useSsl(url) ? { ssl: { rejectUnauthorized: false } } : {}),
  });
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}
