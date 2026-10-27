import { Router } from 'express';
import { eq, sql } from 'drizzle-orm';
import { tours, tourViewsDaily } from '@btv/core';
import { shareIdParamSchema } from '@btv/shared';
import type { AppDeps } from '../deps.js';
import { notFound } from '../errors.js';
import { ah } from '../middleware.js';
import { canViewTour } from '../services/access.js';
import { publicTourToDTO } from '../services/dto.js';
import { parse } from '../validate.js';

/**
 * Unauthenticated endpoints behind the public page (/t/:shareId) and embed (/embed/:shareId).
 * Private tours are visible only to their owner and otherwise look exactly like missing ones.
 */
export function publicRouter({ db, storage, limiters }: AppDeps) {
  const router = Router();

  async function loadVisibleTour(shareId: string, viewerId: string | undefined) {
    const [tour] = await db.select().from(tours).where(eq(tours.shareId, shareId)).limit(1);
    if (!tour || !canViewTour(tour, viewerId)) throw notFound('Tour');
    return tour;
  }

  router.get(
    '/tours/:shareId',
    ah(async (req, res) => {
      const { shareId } = parse(shareIdParamSchema, req.params);
      const tour = await loadVisibleTour(shareId, req.user?.id);
      // Signed media URLs are embedded, so responses must not be shared by caches.
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({ tour: await publicTourToDTO(db, storage, tour) });
    }),
  );

  /**
   * Privacy-friendly view counting: no cookies, IPs or user agents are stored. The client sends
   * one ping per browser session; we only keep an aggregate counter per tour and per day.
   * The owner's own views are not counted.
   */
  router.post(
    '/tours/:shareId/views',
    limiters.publicView,
    ah(async (req, res) => {
      const { shareId } = parse(shareIdParamSchema, req.params);
      const tour = await loadVisibleTour(shareId, req.user?.id);
      if (req.user?.id !== tour.ownerId) {
        const day = new Date().toISOString().slice(0, 10);
        await db.transaction(async (tx) => {
          await tx
            .update(tours)
            .set({ viewCount: sql`${tours.viewCount} + 1` })
            .where(eq(tours.id, tour.id));
          await tx
            .insert(tourViewsDaily)
            .values({ tourId: tour.id, day, count: 1 })
            .onConflictDoUpdate({
              target: [tourViewsDaily.tourId, tourViewsDaily.day],
              set: { count: sql`${tourViewsDaily.count} + 1` },
            });
        });
      }
      res.status(204).end();
    }),
  );

  return router;
}
