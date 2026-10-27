import { Router, type CookieOptions, type Response } from 'express';
import { eq } from 'drizzle-orm';
import { loginSchema, signupSchema, type UserDTO } from '@btv/shared';
import { limitsForPlan, users } from '@btv/core';
import { hashPassword, verifyAgainstDummy, verifyPassword } from '../auth/password.js';
import { createSession, deleteSession, SESSION_COOKIE, type AuthUser } from '../auth/sessions.js';
import { conflict, HttpError } from '../errors.js';
import { ah, currentUser, requireAuth } from '../middleware.js';
import { parse } from '../validate.js';
import type { AppDeps } from '../deps.js';

export function toUserDTO(user: AuthUser): UserDTO {
  return {
    id: user.id,
    email: user.email,
    plan: user.plan,
    limits: limitsForPlan(user.plan),
    createdAt: user.createdAt.toISOString(),
  };
}

export function authRouter(deps: AppDeps): Router {
  const { db, config } = deps;
  const router = Router();

  const cookieOptions = (expires?: Date): CookieOptions => ({
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    path: '/',
    ...(expires ? { expires } : {}),
  });

  async function startSession(res: Response, userId: string) {
    const { token, expiresAt } = await createSession(db, userId, config.SESSION_TTL_DAYS);
    res.cookie(SESSION_COOKIE, token, cookieOptions(expiresAt));
  }

  router.post(
    '/signup',
    deps.limiters.auth,
    ah(async (req, res) => {
      const input = parse(signupSchema, req.body);
      const existing = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, input.email))
        .limit(1);
      if (existing.length)
        throw conflict('email_taken', 'An account with this email already exists.');
      const passwordHash = await hashPassword(input.password);
      const [user] = await db
        .insert(users)
        .values({ email: input.email, passwordHash })
        .onConflictDoNothing()
        .returning();
      if (!user) throw conflict('email_taken', 'An account with this email already exists.');
      await startSession(res, user.id);
      const { passwordHash: _omit, ...publicUser } = user;
      res.status(201).json({ user: toUserDTO(publicUser) });
    }),
  );

  router.post(
    '/login',
    deps.limiters.auth,
    ah(async (req, res) => {
      const input = parse(loginSchema, req.body);
      const [user] = await db.select().from(users).where(eq(users.email, input.email)).limit(1);
      const ok = user
        ? await verifyPassword(user.passwordHash, input.password)
        : await verifyAgainstDummy(input.password);
      if (!user || !ok) {
        throw new HttpError(401, 'invalid_credentials', 'Email or password is incorrect.');
      }
      // A fresh session id on every login prevents session fixation.
      if (req.sessionId) await deleteSession(db, req.sessionId);
      await startSession(res, user.id);
      const { passwordHash: _omit, ...publicUser } = user;
      res.json({ user: toUserDTO(publicUser) });
    }),
  );

  router.post(
    '/logout',
    ah(async (req, res) => {
      if (req.sessionId) await deleteSession(db, req.sessionId);
      res.clearCookie(SESSION_COOKIE, cookieOptions());
      res.status(204).end();
    }),
  );

  router.get('/me', requireAuth, (req, res) => {
    res.json({ user: toUserDTO(currentUser(req)) });
  });

  return router;
}
