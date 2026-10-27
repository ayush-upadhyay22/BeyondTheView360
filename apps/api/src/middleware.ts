import type { NextFunction, Request, RequestHandler, Response } from 'express';
import rateLimit, { type Options } from 'express-rate-limit';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '@btv/shared';
import type { Database } from '@btv/core';
import { findSessionUser, SESSION_COOKIE, type AuthUser } from './auth/sessions.js';
import { errorBody, HttpError, unauthorized } from './errors.js';
import type { ApiConfig } from './config.js';

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
    sessionId?: string;
  }
}

/** Wraps an async handler so rejections reach the error middleware. */
export function ah(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

/** Attaches `req.user` when a valid session cookie is present. Never rejects by itself. */
export function sessionMiddleware(db: Database): RequestHandler {
  return ah(async (req, _res, next) => {
    const token: unknown = req.cookies?.[SESSION_COOKIE];
    if (typeof token === 'string' && token) {
      const found = await findSessionUser(db, token);
      if (found) {
        req.user = found.user;
        req.sessionId = found.sessionId;
      }
    }
    next();
  });
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.user) return next(unauthorized());
  next();
};

/** Narrowing helper for handlers mounted behind `requireAuth`. */
export function currentUser(req: Request): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence in depth (cookies are also SameSite=Lax):
 * 1. every state-changing request must send the custom `x-btv-csrf` header — cross-site forms
 *    cannot set custom headers and cross-origin fetches need a CORS preflight we only allow
 *    for allowlisted origins;
 * 2. if the browser sends an Origin header it must be allowlisted (or same-origin).
 */
export function csrfProtection(config: ApiConfig): RequestHandler {
  const allowed = new Set([...config.CORS_ORIGINS, config.WEB_ORIGIN]);
  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    if (req.get(CSRF_HEADER) !== CSRF_HEADER_VALUE) {
      return next(new HttpError(403, 'csrf', 'Missing CSRF header.'));
    }
    const origin = req.get('origin');
    if (origin && origin !== 'null') {
      const sameOrigin = origin === `${req.protocol}://${req.get('host')}`;
      if (!sameOrigin && !allowed.has(origin)) {
        return next(new HttpError(403, 'csrf', 'Origin not allowed.'));
      }
    }
    next();
  };
}

export interface RateLimiters {
  api: RequestHandler;
  auth: RequestHandler;
  upload: RequestHandler;
  publicView: RequestHandler;
}

/**
 * In-memory limiters (per process).
 * EXTENSION POINT: when running several API replicas, pass a shared `store`
 * (e.g. `rate-limit-redis`) so limits apply across instances.
 */
export function createRateLimiters(config: ApiConfig): RateLimiters {
  const make = (opts: Partial<Options>): RequestHandler => {
    if (!config.RATE_LIMIT_ENABLED) return (_req, _res, next) => next();
    return rateLimit({
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      handler: (_req, res, _next, options) => {
        res
          .status(options.statusCode)
          .json(errorBody('rate_limited', 'Too many requests. Please slow down and try again.'));
      },
      ...opts,
    });
  };
  const userOrIp = (req: Request) => req.user?.id ?? req.ip ?? 'unknown';
  return {
    api: make({ windowMs: 60_000, limit: 600 }),
    // Brute-force protection for login/signup, keyed by IP.
    auth: make({ windowMs: 15 * 60_000, limit: 30 }),
    upload: make({ windowMs: 15 * 60_000, limit: 200, keyGenerator: userOrIp }),
    publicView: make({ windowMs: 60_000, limit: 60 }),
  };
}
