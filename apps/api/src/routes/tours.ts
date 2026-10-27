import { Router } from 'express';
import { and, asc, count, desc, eq, gte, inArray } from 'drizzle-orm';
import {
  autoLinkNearbySchema,
  bearingToYaw,
  CHAIN_ARROW_PITCH,
  createTourSchema,
  FLOOR_PLAN_CONTENT_TYPE,
  FLOOR_PLAN_MAX_BYTES,
  floorPlanCompleteSchema,
  floorPlanPresignSchema,
  linkInOrderSchema,
  MAX_HOTSPOTS_PER_SCENE,
  neighborPairs,
  planBearing,
  reorderScenesSchema,
  round,
  updateTourSchema,
  uuidParamSchema,
  type FloorPlanPresignResponse,
  type TourStatsDTO,
} from '@btv/shared';
import {
  allSceneKeys,
  hotspots,
  isFloorPlanKeyOf,
  limitsForPlan,
  linkInOrder,
  lockTour,
  randomId,
  scenes,
  storageKeys,
  tours,
  tourViewsDaily,
  type SceneRow,
} from '@btv/core';
import { badRequest, conflict, HttpError, limitReached } from '../errors.js';
import { ah, currentUser, requireAuth } from '../middleware.js';
import { loadOwnedTour } from '../services/access.js';
import { tourSummaryToDTO, tourToDTO } from '../services/dto.js';
import { parse } from '../validate.js';
import type { AppDeps } from '../deps.js';

/** RIFF....WEBP container signature. */
export function isWebp(bytes: Uint8Array): boolean {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  return bytes.length > 16 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
}

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
      if (tour.floorPlanKey) keys.push(tour.floorPlanKey);
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

  /** Adds missing next/back arrows in scene order (`rebuild` also drops arrows that break it). */
  router.post(
    '/:id/link-in-order',
    ah(async (req, res) => {
      const { id } = parse(uuidParamSchema, req.params);
      const { mode } = parse(linkInOrderSchema, req.body ?? {});
      const tour = await loadOwnedTour(db, id, currentUser(req).id);
      const result = await db.transaction(async (tx) => {
        await lockTour(tx, tour.id);
        const r = await linkInOrder(tx, tour.id, mode);
        await tx.update(tours).set({ updatedAt: new Date() }).where(eq(tours.id, tour.id));
        return r;
      });
      res.json({ result, tour: await tourToDTO(db, storage, tour) });
    }),
  );

  /** Links every pinned scene to its nearest pinned neighbours, aimed by floor-plan bearing. */
  router.post(
    '/:id/auto-link-nearby',
    ah(async (req, res) => {
      const { id } = parse(uuidParamSchema, req.params);
      const { neighbors } = parse(autoLinkNearbySchema, req.body ?? {});
      const tour = await loadOwnedTour(db, id, currentUser(req).id);
      const aspect =
        tour.floorPlanWidth && tour.floorPlanHeight
          ? tour.floorPlanWidth / tour.floorPlanHeight
          : 1;
      const added = await db.transaction(async (tx) => {
        await lockTour(tx, tour.id);
        const pinned = (await tx.select().from(scenes).where(eq(scenes.tourId, tour.id))).filter(
          (s) => s.status !== 'failed' && s.mapX !== null && s.mapY !== null,
        );
        if (pinned.length < 2) return 0;
        const byId = new Map(pinned.map((s) => [s.id, s]));
        const existing = await tx
          .select({ sceneId: hotspots.sceneId, targetSceneId: hotspots.targetSceneId })
          .from(hotspots)
          .where(
            inArray(
              hotspots.sceneId,
              pinned.map((s) => s.id),
            ),
          );
        const linked = new Set(existing.map((h) => `${h.sceneId}|${h.targetSceneId}`));
        const counts = new Map<string, number>();
        for (const h of existing) counts.set(h.sceneId, (counts.get(h.sceneId) ?? 0) + 1);

        const rows: (typeof hotspots.$inferInsert)[] = [];
        const pins = pinned.map((s) => ({ id: s.id, x: s.mapX!, y: s.mapY! }));
        for (const [a, b] of neighborPairs(pins, neighbors, aspect)) {
          for (const [from, to] of [
            [a, b],
            [b, a],
          ] as const) {
            const n = counts.get(from) ?? 0;
            if (linked.has(`${from}|${to}`) || n >= MAX_HOTSPOTS_PER_SCENE) continue;
            const src = byId.get(from)!;
            const dst = byId.get(to)!;
            const bearing = planBearing(
              { x: src.mapX!, y: src.mapY! },
              { x: dst.mapX!, y: dst.mapY! },
              aspect,
            );
            rows.push({
              sceneId: from,
              kind: 'link',
              yaw: round(bearingToYaw(bearing, src.northOffset), 2),
              pitch: CHAIN_ARROW_PITCH,
              targetSceneId: to,
              title: '',
            });
            counts.set(from, n + 1);
            linked.add(`${from}|${to}`);
          }
        }
        if (rows.length) await tx.insert(hotspots).values(rows);
        await tx.update(tours).set({ updatedAt: new Date() }).where(eq(tours.id, tour.id));
        return rows.length;
      });
      res.json({ result: { added, removed: 0 }, tour: await tourToDTO(db, storage, tour) });
    }),
  );

  /** Floor plan step 1: presigned POST for a WebP the browser has already re-encoded. */
  router.post(
    '/:id/floor-plan/presign',
    deps.limiters.upload,
    ah(async (req, res) => {
      const { id } = parse(uuidParamSchema, req.params);
      const input = parse(floorPlanPresignSchema, req.body);
      const tour = await loadOwnedTour(db, id, currentUser(req).id);
      if (input.size > FLOOR_PLAN_MAX_BYTES) {
        throw new HttpError(413, 'file_too_large', 'Floor plans can be at most 5 MB.');
      }
      const key = storageKeys.floorPlan(tour.id, randomId(16));
      const upload = await storage.presignUpload({
        key,
        contentType: FLOOR_PLAN_CONTENT_TYPE,
        maxBytes: FLOOR_PLAN_MAX_BYTES,
        expiresInSeconds: deps.config.UPLOAD_URL_TTL_SECONDS,
      });
      const body: FloorPlanPresignResponse = {
        key,
        upload: {
          url: upload.url,
          fields: upload.fields,
          maxBytes: FLOOR_PLAN_MAX_BYTES,
          expiresAt: upload.expiresAt.toISOString(),
        },
      };
      res.status(201).json(body);
    }),
  );

  /** Floor plan step 2: verify the uploaded object really is a WebP and attach it. */
  router.post(
    '/:id/floor-plan/complete',
    deps.limiters.upload,
    ah(async (req, res) => {
      const { id } = parse(uuidParamSchema, req.params);
      const input = parse(floorPlanCompleteSchema, req.body);
      const tour = await loadOwnedTour(db, id, currentUser(req).id);
      if (!isFloorPlanKeyOf(tour.id, input.key)) throw badRequest('Unknown floor plan upload.');
      const info = await storage.head(input.key);
      if (!info) {
        throw conflict('upload_missing', 'The floor plan did not reach storage. Please retry.');
      }
      const bytes = info.size <= FLOOR_PLAN_MAX_BYTES ? await storage.get(input.key) : null;
      if (!bytes || !isWebp(bytes)) {
        await storage.delete(input.key);
        throw badRequest('The floor plan must be a WebP image.');
      }
      const [updated] = await db
        .update(tours)
        .set({
          floorPlanKey: input.key,
          floorPlanWidth: input.width,
          floorPlanHeight: input.height,
          updatedAt: new Date(),
        })
        .where(eq(tours.id, tour.id))
        .returning();
      if (tour.floorPlanKey && tour.floorPlanKey !== input.key) {
        storage.delete(tour.floorPlanKey).catch((err: unknown) => {
          logger.warn({ err, tourId: tour.id }, 'failed to delete old floor plan');
        });
      }
      res.json({ tour: await tourToDTO(db, storage, updated!) });
    }),
  );

  router.delete(
    '/:id/floor-plan',
    ah(async (req, res) => {
      const { id } = parse(uuidParamSchema, req.params);
      const tour = await loadOwnedTour(db, id, currentUser(req).id);
      const [updated] = await db
        .update(tours)
        .set({ floorPlanKey: null, floorPlanWidth: null, floorPlanHeight: null })
        .where(eq(tours.id, tour.id))
        .returning();
      if (tour.floorPlanKey) await storage.delete(tour.floorPlanKey).catch(() => undefined);
      res.json({ tour: await tourToDTO(db, storage, updated!) });
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
