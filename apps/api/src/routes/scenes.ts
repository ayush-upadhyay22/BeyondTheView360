import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { and, count, eq, max, ne } from 'drizzle-orm';
import {
  ALLOWED_UPLOAD_TYPES,
  createHotspotSchema,
  MAX_HOTSPOTS_PER_SCENE,
  presignUploadSchema,
  updateSceneSchema,
  uuidParamSchema,
  type PresignUploadResponse,
} from '@btv/shared';
import { allSceneKeys, hotspots, limitsForPlan, scenes, storageKeys, tours } from '@btv/core';
import { badRequest, conflict, HttpError, limitReached } from '../errors.js';
import { ah, currentUser, requireAuth } from '../middleware.js';
import { loadOwnedScene, loadOwnedTour } from '../services/access.js';
import { hotspotToDTO, sceneWithHotspotsToDTO } from '../services/dto.js';
import { parse } from '../validate.js';
import type { AppDeps } from '../deps.js';

/** "living-room_01.jpg" -> "living room 01" */
export function sceneNameFromFilename(filename: string): string {
  const base = filename
    .replace(/^.*[\\/]/, '')
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return base.slice(0, 120) || 'Untitled scene';
}

export function scenesRouter(deps: AppDeps): Router {
  const { db, storage, queue, config, logger } = deps;
  const router = Router();
  router.use(requireAuth);

  /** Step 1: reserve a scene and hand the browser a presigned POST straight to S3. */
  router.post(
    '/presign',
    deps.limiters.upload,
    ah(async (req, res) => {
      const user = currentUser(req);
      const input = parse(presignUploadSchema, req.body);
      const tour = await loadOwnedTour(db, input.tourId, user.id);
      const limits = limitsForPlan(user.plan);

      if (input.size > limits.maxUploadBytes) {
        throw new HttpError(
          413,
          'file_too_large',
          `Images can be at most ${Math.round(limits.maxUploadBytes / 1024 / 1024)} MB on your plan.`,
        );
      }
      const [stats] = await db
        .select({ n: count(), maxPos: max(scenes.position) })
        .from(scenes)
        .where(eq(scenes.tourId, tour.id));
      if ((stats?.n ?? 0) >= limits.maxScenesPerTour) {
        throw limitReached(`Your plan allows ${limits.maxScenesPerTour} scenes per tour.`);
      }

      const id = randomUUID();
      const originalKey = storageKeys.original(id);
      const [scene] = await db
        .insert(scenes)
        .values({
          id,
          tourId: tour.id,
          name: sceneNameFromFilename(input.filename),
          position: (stats?.maxPos ?? -1) + 1,
          status: 'pending',
          originalKey,
          contentType: input.contentType,
          sizeBytes: input.size,
        })
        .returning();

      const upload = await storage.presignUpload({
        key: originalKey,
        contentType: input.contentType,
        maxBytes: limits.maxUploadBytes,
        expiresInSeconds: config.UPLOAD_URL_TTL_SECONDS,
      });
      await db.update(tours).set({ updatedAt: new Date() }).where(eq(tours.id, tour.id));

      const body: PresignUploadResponse = {
        scene: await sceneWithHotspotsToDTO(db, storage, scene!),
        upload: {
          url: upload.url,
          fields: upload.fields,
          maxBytes: limits.maxUploadBytes,
          expiresAt: upload.expiresAt.toISOString(),
        },
      };
      res.status(201).json(body);
    }),
  );

  /** Step 2: the browser finished uploading — verify the object and queue processing. */
  router.post(
    '/:id/complete',
    deps.limiters.upload,
    ah(async (req, res) => {
      const { id } = parse(uuidParamSchema, req.params);
      const user = currentUser(req);
      const { scene } = await loadOwnedScene(db, id, user.id);

      if (scene.status !== 'pending') {
        // Idempotent: completing twice is harmless.
        res.status(202).json({ scene: await sceneWithHotspotsToDTO(db, storage, scene) });
        return;
      }

      const info = await storage.head(scene.originalKey);
      if (!info) {
        throw conflict(
          'upload_missing',
          'We could not find the uploaded file. Please try uploading it again.',
        );
      }
      const limits = limitsForPlan(user.plan);
      if (info.size <= 0 || info.size > limits.maxUploadBytes) {
        await storage.delete(scene.originalKey);
        throw new HttpError(413, 'file_too_large', 'The uploaded file exceeds the size limit.');
      }
      if (
        info.contentType &&
        !(ALLOWED_UPLOAD_TYPES as readonly string[]).includes(info.contentType)
      ) {
        throw badRequest('Only JPEG, PNG and WebP images are supported.');
      }

      const [updated] = await db
        .update(scenes)
        .set({
          status: 'queued',
          progress: 0,
          error: null,
          sizeBytes: info.size,
          queuedAt: new Date(),
        })
        .where(and(eq(scenes.id, scene.id), eq(scenes.status, 'pending')))
        .returning();

      try {
        await queue.enqueue(scene.id);
      } catch (err) {
        // The scene stays "queued"; the worker's stuck-scene sweeper will pick it up.
        logger.error({ err, sceneId: scene.id }, 'failed to enqueue scene; sweeper will retry');
      }
      res.status(202).json({ scene: await sceneWithHotspotsToDTO(db, storage, updated ?? scene) });
    }),
  );

  /** Re-run processing for a failed scene (e.g. after a transient outage). */
  router.post(
    '/:id/retry',
    deps.limiters.upload,
    ah(async (req, res) => {
      const { id } = parse(uuidParamSchema, req.params);
      const { scene } = await loadOwnedScene(db, id, currentUser(req).id);
      if (scene.status !== 'failed') throw badRequest('Only failed scenes can be retried.');
      if (!(await storage.head(scene.originalKey))) {
        throw conflict('upload_missing', 'The original file is gone. Please upload it again.');
      }
      const [updated] = await db
        .update(scenes)
        .set({ status: 'queued', progress: 0, error: null, queuedAt: new Date() })
        .where(eq(scenes.id, scene.id))
        .returning();
      await queue.enqueue(scene.id);
      res.status(202).json({ scene: await sceneWithHotspotsToDTO(db, storage, updated!) });
    }),
  );

  router.get(
    '/:id',
    ah(async (req, res) => {
      const { id } = parse(uuidParamSchema, req.params);
      const { scene } = await loadOwnedScene(db, id, currentUser(req).id);
      res.json({ scene: await sceneWithHotspotsToDTO(db, storage, scene) });
    }),
  );

  router.patch(
    '/:id',
    ah(async (req, res) => {
      const { id } = parse(uuidParamSchema, req.params);
      const input = parse(updateSceneSchema, req.body);
      const { scene } = await loadOwnedScene(db, id, currentUser(req).id);
      const [updated] = await db
        .update(scenes)
        .set(input)
        .where(eq(scenes.id, scene.id))
        .returning();
      res.json({ scene: await sceneWithHotspotsToDTO(db, storage, updated!) });
    }),
  );

  router.delete(
    '/:id',
    ah(async (req, res) => {
      const { id } = parse(uuidParamSchema, req.params);
      const { scene } = await loadOwnedScene(db, id, currentUser(req).id);
      await db.delete(scenes).where(eq(scenes.id, scene.id));
      storage.delete(allSceneKeys(scene)).catch((err: unknown) => {
        logger.warn({ err, sceneId: scene.id }, 'failed to delete scene objects');
      });
      res.status(204).end();
    }),
  );

  router.post(
    '/:id/hotspots',
    ah(async (req, res) => {
      const { id } = parse(uuidParamSchema, req.params);
      const input = parse(createHotspotSchema, req.body);
      const { scene } = await loadOwnedScene(db, id, currentUser(req).id);

      const [existing] = await db
        .select({ n: count() })
        .from(hotspots)
        .where(eq(hotspots.sceneId, scene.id));
      if ((existing?.n ?? 0) >= MAX_HOTSPOTS_PER_SCENE) {
        throw badRequest(`A scene can have at most ${MAX_HOTSPOTS_PER_SCENE} hotspots.`);
      }

      if (input.type === 'link') {
        const [target] = await db
          .select({ id: scenes.id })
          .from(scenes)
          .where(
            and(
              eq(scenes.id, input.targetSceneId),
              eq(scenes.tourId, scene.tourId),
              ne(scenes.id, scene.id),
            ),
          )
          .limit(1);
        if (!target) throw badRequest('Link target must be another scene of the same tour.');
      }

      const [hotspot] = await db
        .insert(hotspots)
        .values(
          input.type === 'link'
            ? {
                sceneId: scene.id,
                type: 'link',
                yaw: input.yaw,
                pitch: input.pitch,
                targetSceneId: input.targetSceneId,
                title: input.title,
              }
            : {
                sceneId: scene.id,
                type: 'info',
                yaw: input.yaw,
                pitch: input.pitch,
                title: input.title,
                text: input.text,
                imageUrl: input.imageUrl,
              },
        )
        .returning();
      res.status(201).json({ hotspot: hotspotToDTO(hotspot!) });
    }),
  );

  return router;
}
