/**
 * Idempotent development seed: the demo user and an empty, unlisted demo tour.
 * Fill it with images via `npm run samples:upload`.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { createDb, loadEnvFiles, tours, users } from '@btv/core';
import { hashPassword } from '../src/auth/password.js';
import { DEMO } from './demo.js';

const here = dirname(fileURLToPath(import.meta.url));
loadEnvFiles(resolve(here, '..'));

if (process.env.NODE_ENV === 'production' && process.env.ALLOW_SEED !== '1') {
  console.error('Refusing to seed a production database (set ALLOW_SEED=1 to override).');
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const { db, close } = createDb(url, { max: 1 });

try {
  const email = DEMO.email.trim().toLowerCase();
  let [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (user) {
    // Keep the documented password working even if it was changed locally.
    await db
      .update(users)
      .set({ passwordHash: await hashPassword(DEMO.password), updatedAt: new Date() })
      .where(eq(users.id, user.id));
    console.info(`✓ demo user exists: ${email} (password reset to the documented one)`);
  } else {
    [user] = await db
      .insert(users)
      .values({ email, passwordHash: await hashPassword(DEMO.password) })
      .returning();
    console.info(`✓ created demo user: ${email}`);
  }

  const [tour] = await db.select().from(tours).where(eq(tours.shareId, DEMO.shareId)).limit(1);
  if (tour) {
    console.info(`✓ demo tour exists (/t/${DEMO.shareId})`);
  } else {
    await db.insert(tours).values({
      ownerId: user!.id,
      shareId: DEMO.shareId,
      title: DEMO.tourTitle,
      description: DEMO.tourDescription,
      visibility: 'unlisted',
    });
    console.info(`✓ created demo tour (/t/${DEMO.shareId})`);
  }

  console.info(`\nLog in with ${email} / ${DEMO.password}`);
} finally {
  await close();
}
