import type { Database, Logger } from '@btv/core';
import type { ApiConfig } from './config.js';
import type { RateLimiters } from './middleware.js';

/** Everything the HTTP layer needs. Built once in server.ts (or by tests). */
export interface AppDeps {
  config: ApiConfig;
  db: Database;
  logger: Logger;
  limiters: RateLimiters;
  /** Readiness probes for external services. */
  checks: Record<string, () => Promise<unknown>>;
}
