import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, lt } from 'drizzle-orm';
import { sessions, users, type Database, type UserRow } from '@btv/core';

export const SESSION_COOKIE = 'btv_session';

export type AuthUser = Omit<UserRow, 'passwordHash'>;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(
  db: Database,
  userId: string,
  ttlDays: number,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 3600 * 1000);
  // Opportunistic cleanup of this user's expired sessions.
  await db
    .delete(sessions)
    .where(and(eq(sessions.userId, userId), lt(sessions.expiresAt, new Date())));
  await db.insert(sessions).values({ id: hashToken(token), userId, expiresAt });
  return { token, expiresAt };
}

export async function findSessionUser(
  db: Database,
  token: string,
): Promise<{ sessionId: string; user: AuthUser } | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const id = hashToken(token);
  const rows = await db
    .select({
      sessionId: sessions.id,
      id: users.id,
      email: users.email,
      plan: users.plan,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, id), gt(sessions.expiresAt, new Date())))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const { sessionId, ...user } = row;
  return { sessionId, user };
}

export async function deleteSession(db: Database, sessionId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}
