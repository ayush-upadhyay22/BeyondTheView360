import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import express, { Router, type Express, type RequestHandler } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { randomUUID } from 'node:crypto';
import { CSRF_HEADER } from '@btv/shared';
import { errorBody, errorHandler } from './errors.js';
import { ah, csrfProtection, sessionMiddleware } from './middleware.js';
import { DatabaseStorageDriver } from '@btv/core';
import { authRouter } from './routes/auth.js';
import { databaseStorageRouter } from './routes/database-storage.js';
import { hotspotsRouter } from './routes/hotspots.js';
import { publicRouter } from './routes/public.js';
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
      autoLogging: {
        ignore: (req) =>
          (req.url?.startsWith('/api/healthz') || req.url?.startsWith('/api/storage/')) ?? false,
      },
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

  const api = Router();
  const apiHelmet = helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  // SPA pages need a real document CSP; keep the locked-down policy on /api only then.
  if (deps.spa) api.use(apiHelmet);
  else app.use(apiHelmet);

  const allowedOrigins = new Set(config.CORS_ORIGINS);
  if (deps.spa) allowedOrigins.add(config.WEB_ORIGIN);
  app.use(
    cors({
      origin: (origin, cb) =>
        cb(null, !origin || allowedOrigins.has(origin) || Boolean(deps.spa)),
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
      allowedHeaders: ['content-type', CSRF_HEADER],
      maxAge: 600,
    }),
  );

  app.use(express.json({ limit: config.JSON_BODY_LIMIT }));
  app.use(cookieParser());

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

  // Same contract as S3 presign: the browser POSTs the file without the CSRF header.
  if (deps.storage.name === 'database') {
    api.use(databaseStorageRouter(deps.storage as DatabaseStorageDriver));
  }

  api.use(sessionMiddleware(deps.db));
  api.use(csrfProtection(config));

  api.use('/auth', authRouter(deps));
  api.use('/tours', toursRouter(deps));
  api.use('/scenes', scenesRouter(deps));
  api.use('/hotspots', hotspotsRouter(deps));
  api.use('/public', publicRouter(deps));

  api.use((_req, res) => {
    res.status(404).json(errorBody('not_found', 'Endpoint not found.'));
  });

  app.use('/api', api);

  if (deps.spa) {
    mountSpa(app, deps.spa);
  } else {
    app.use((_req, res) => {
      res.status(404).json(errorBody('not_found', 'Not found.'));
    });
  }
  app.use(errorHandler(logger));

  return app;
}

function spaHeaders(frameAncestors: string[], mediaOrigins: string[], embeddable: boolean): RequestHandler {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:', ...mediaOrigins],
        connectSrc: ["'self'", ...mediaOrigins],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors,
        upgradeInsecureRequests: null,
      },
    },
    frameguard: embeddable ? false : { action: 'sameorigin' },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  });
}

function mountSpa(app: Express, spa: NonNullable<AppDeps['spa']>): void {
  const indexHtml = resolve(spa.dir, 'index.html');
  if (!existsSync(indexHtml)) {
    throw new Error(`SPA build not found at ${indexHtml}. Run "npm run build -w @btv/web" first.`);
  }
  const mediaOrigins = spa.mediaOrigins ?? [];
  const embedAncestors = spa.embedAncestors ?? ['*'];
  const embedHeaders = spaHeaders(embedAncestors, mediaOrigins, true);
  const appHeaders = spaHeaders(["'self'"], mediaOrigins, false);

  app.use(
    '/assets',
    express.static(resolve(spa.dir, 'assets'), { immutable: true, maxAge: '1y', index: false }),
  );
  app.use(express.static(spa.dir, { index: false, maxAge: '1h' }));
  app.get('/{*path}', (req, res, next) => {
    const headers = req.path.startsWith('/embed/') ? embedHeaders : appHeaders;
    headers(req, res, () => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(indexHtml, (err) => err && next(err));
    });
  });
}
