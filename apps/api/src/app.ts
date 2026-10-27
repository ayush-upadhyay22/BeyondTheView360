import express, { Router, type Express } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { randomUUID } from 'node:crypto';
import { CSRF_HEADER } from '@btv/shared';
import { errorBody, errorHandler } from './errors.js';
import { ah, csrfProtection, sessionMiddleware } from './middleware.js';
import { authRouter } from './routes/auth.js';
import { hotspotsRouter } from './routes/hotspots.js';
import { scenesRouter } from './routes/scenes.js';
import { toursRouter } from './routes/tours.js';
import type { AppDeps } from './deps.js';

export type { AppDeps } from './deps.js';
export { loadApiConfig, type ApiConfig } from './config.js';
export { createRateLimiters } from './middleware.js';

export function createApp(deps: AppDeps): Express {
  const { config, logger } = deps;
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY);

  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
      autoLogging: { ignore: (req) => req.url?.startsWith('/api/healthz') ?? false },
      customLogLevel: (_req, res, err) =>
        err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
      serializers: {
        // Only log what we need; headers (cookies!) and bodies are never logged.
        req: (req: { id: unknown; method: string; url: string }) => ({
          id: req.id,
          method: req.method,
          url: req.url,
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );

  // JSON API: nothing here should ever render as a document or be framed.
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );

  const allowedOrigins = new Set(config.CORS_ORIGINS);
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || allowedOrigins.has(origin)),
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
      allowedHeaders: ['content-type', CSRF_HEADER],
      maxAge: 600,
    }),
  );

  app.use(express.json({ limit: config.JSON_BODY_LIMIT }));
  app.use(cookieParser());

  const api = Router();

  api.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });
  api.get(
    '/readyz',
    ah(async (_req, res) => {
      const results = await Promise.allSettled(
        Object.entries(deps.checks).map(async ([name, check]) => {
          await check();
          return name;
        }),
      );
      const failed = Object.keys(deps.checks).filter((_, i) => results[i]?.status === 'rejected');
      res.status(failed.length ? 503 : 200).json({ ok: failed.length === 0, failed });
    }),
  );

  api.use(deps.limiters.api);
  api.use(sessionMiddleware(deps.db));
  api.use(csrfProtection(config));

  api.use('/auth', authRouter(deps));
  api.use('/tours', toursRouter(deps));
  api.use('/scenes', scenesRouter(deps));
  api.use('/hotspots', hotspotsRouter(deps));

  api.use((_req, res) => {
    res.status(404).json(errorBody('not_found', 'Endpoint not found.'));
  });

  app.use('/api', api);
  app.use((_req, res) => {
    res.status(404).json(errorBody('not_found', 'Not found.'));
  });
  app.use(errorHandler(logger));

  return app;
}
