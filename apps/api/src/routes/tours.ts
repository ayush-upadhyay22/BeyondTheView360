import { Router } from 'express';
import { and, asc, count, desc, eq, gte, inArray } from 'drizzle-orm';
import {
  createTourSchema,
  reorderScenesSchema,
  updateTourSchema,
  uuidParamSchema,
  type TourStatsDTO,
} from '@btv/shared';
import {
  allSceneKeys,
  limitsForPlan,
  randomId,
  scenes,
  tours,
  tourViewsDaily,
  type SceneRow,
} from '@btv/core';
import { badRequest, limitReached } from '../errors.js';
import { ah, currentUser, requireAuth } from '../middleware.js';
import { loadOwnedTour } from '../services/access.js';
import { tourSummaryToDTO, tourToDTO } from '../services/dto.js';
import { parse } from '../validate.js';
import type { AppDeps } from '../deps.js';

export function toursRouter(deps: AppDeps): Router {
  const { db, storage, logger } = deps;
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/',
    ah(async (req, res) => {
      const user = currentUser(req);
      const list = await db
        .select()
        .from(tours)
        .where(eq(tours.ownerId, user.id))
        .orderBy(desc(tours.updatedAt));
      const sceneRows = list.length
        ? await db
            .select()
            .from(scenes)
            .where(
              inArray(
                scenes.tourId,
                list.map((t) => t.id),
              ),
            )
            .orderBy(asc(scenes.position))
        : [];
      const byTour = new Map<string, SceneRow[]>();
      for (const s of sceneRows) byTour.set(s.tourId, [...(byTour.get(s.tourId) ?? []), s]);
      res.json({
        tours: await Promise.all(
          list.map((t) => tourSummaryToDTO(storage, t, byTour.get(t.id) ?? [])),
        ),
      });
    }),
  );

  router.post(
    '/',
    ah(async (req, res) => {
      const user = currentUser(req);
      const input = parse(createTourSchema, req.body);
      const limits = limitsForPlan(user.plan);
      const [existing] = await db
        .select({ n: count() })
        .from(tours)
        .where(eq(tours.ownerId, user.id));
      if ((existing?.n ?? 0) >= limits.maxTours) {
        throw limitReached(
          `Your plan allows ${limits.maxTours} tours. Delete a tour or upgrade to create more.`,
        );
      }
      const [tour] = await db
        .insert(tours)
        .values({ ownerId: user.id, title: input.title, shareId: randomId(10) })
        .returning();
      res.status(201).json({ tour: await tourToDTO(db, storage, tour!) });
    }),
  );

  router.get(
    '/:id',
    ah(async (req, res) => {
      const { id } = parse(uuidParamSchema, req.params);
      const tour = await loadOwnedTour(db, id, currentUser(req).id);
      res.json({ tour: await tourToDTO(db, storage, tour) });
    }),
  );

  router.patch(
    '/:id',
    ah(async (req, res) => {
      const { id } = parse(uuidParamSchema, req.params);
      const input = parse(updateTourSchema, req.body);
      const tour = await loadOwnedTour(db, id, currentUser(req).id);
      if (input.startSceneId) {
        const [scene] = await db
          .select({ id: scenes.id })
          .from(scenes)
          .where(and(eq(scenes.id, input.startSceneId), eq(scenes.tourId, tour.id)))
          .limit(1);
        if (!scene) throw badRequest('Start scene must belong to this tour.');
      }
      const [updated] = await db
        .update(tours)
        .set({ ...input, updatedAt: new Date() })
        .where(eq(tours.id, tour.id))
        .returning();
      res.json({ tour: await tourToDTO(db, storage, updated!) });
    }),
  );

  router.delete(
    '/:id',
    ah(async (req, res) => {
      const { id } = parse(uuidParamSchema, req.params);
      const tour = await loadOwnedTour(db, id, currentUser(req).id);
      const sceneRows = await db.select().from(scenes).where(eq(scenes.tourId, tour.id));
      await db.delete(tours).where(eq(tours.id, tour.id));
      // Rows are gone (cascade); object cleanup is best-effort and never blocks the user.
      const keys = sceneRows.flatMap(allSceneKeys);
      storage.delete(keys).catch((err: unknown) => {
        logger.warn({ err, tourId: tour.id }, 'failed to delete tour objects');
      });
      res.status(204).end();
    }),
  );

  router.put(
    '/:id/scenes/order',
    ah(async (req, res) => {
      const { id } = parse(uuidParamSchema, req.params);
      const { sceneIds } = parse(reorderScenesSchema, req.body);
      const tour = await loadOwnedTour(db, id, currentUser(req).id);
      const current = await db
        .select({ id: scenes.id })
        .from(scenes)
        .where(eq(scenes.tourId, tour.id));
      const known = new Set(current.map((s) => s.id));
      if (
        sceneIds.length !== known.size ||
        new Set(sceneIds).size !== sceneIds.length ||
        !sceneIds.every((sid) => known.has(sid))
      ) {
        throw badRequest('sceneIds must list every scene of the tour exactly once.');
      }
      await db.transaction(async (tx) => {
        for (const [position, sceneId] of sceneIds.entries()) {
          await tx.update(scenes).set({ position }).where(eq(scenes.id, sceneId));
        }
        await tx.update(tours).set({ updatedAt: new Date() }).where(eq(tours.id, tour.id));
      });
      res.json({ tour: await tourToDTO(db, storage, tour) });
    }),
  );

  router.get(
    '/:id/stats',
    ah(async (req, res) => {
      const { id } = parse(uuidParamSchema, req.params);
      const tour = await loadOwnedTour(db, id, currentUser(req).id);
      const since = new Date(Date.now() - 29 * 24 * 3600 * 1000).toISOString().slice(0, 10);
      const daily = await db
        .select({ day: tourViewsDaily.day, count: tourViewsDaily.count })
        .from(tourViewsDaily)
        .where(and(eq(tourViewsDaily.tourId, tour.id), gte(tourViewsDaily.day, since)))
        .orderBy(asc(tourViewsDaily.day));
      const body: TourStatsDTO = { tourId: tour.id, total: tour.viewCount, daily };
      res.json(body);
    }),
  );

  return router;
}
