import { Router } from 'express';
import { and, eq, ne } from 'drizzle-orm';
import { updateHotspotSchema, uuidParamSchema } from '@btv/shared';
import { hotspots, scenes } from '@btv/core';
import { badRequest, conflict } from '../errors.js';
import { ah, currentUser, requireAuth } from '../middleware.js';
import { loadOwnedHotspot } from '../services/access.js';
import { hotspotToDTO } from '../services/dto.js';
import { parse } from '../validate.js';
import type { AppDeps } from '../deps.js';

export function hotspotsRouter(deps: AppDeps): Router {
  const { db } = deps;
  const router = Router();
  router.use(requireAuth);

  router.patch(
    '/:id',
    ah(async (req, res) => {
      const { id } = parse(uuidParamSchema, req.params);
      const input = parse(updateHotspotSchema, req.body);
      const { hotspot, scene } = await loadOwnedHotspot(db, id, currentUser(req).id);

      if (hotspot.kind !== 'info') {
        if (input.text !== undefined || input.imageUrl !== undefined) {
          throw badRequest('Arrows and link hotspots have no text or image.');
        }
        if (input.targetSceneId) {
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
      } else if (input.targetSceneId !== undefined) {
        throw badRequest('Info hotspots cannot link to a scene.');
      }
      if (hotspot.kind === 'info' && input.title !== undefined && !input.title) {
        throw badRequest('Info hotspots need a title.');
      }

      const updated = await db
        .update(hotspots)
        .set(input)
        .where(eq(hotspots.id, hotspot.id))
        .returning()
        .then((rows) => rows[0])
        .catch((err: unknown) => {
          // Retargeting a next/back arrow onto a scene that already has one.
          if ((err as { code?: string }).code === '23505') {
            throw conflict('duplicate_arrow', 'This scene already has that arrow.');
          }
          throw err;
        });
      res.json({ hotspot: hotspotToDTO(updated!) });
    }),
  );

  router.delete(
    '/:id',
    ah(async (req, res) => {
      const { id } = parse(uuidParamSchema, req.params);
      const { hotspot } = await loadOwnedHotspot(db, id, currentUser(req).id);
      await db.delete(hotspots).where(eq(hotspots.id, hotspot.id));
      res.status(204).end();
    }),
  );

  return router;
}
