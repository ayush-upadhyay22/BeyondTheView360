import { z } from 'zod';
import { ALLOWED_UPLOAD_TYPES, MAX_FOV, MIN_FOV, TOUR_VISIBILITIES } from './constants.js';

const uuid = z.string().uuid();
const yaw = z.number().finite().min(-180).max(180);
const pitch = z.number().finite().min(-90).max(90);

export const httpUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .url()
  .refine((value) => /^https?:\/\//i.test(value), 'Only http(s) URLs are allowed');

export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(200, 'Password is too long');

export const signupSchema = z.object({ email: emailSchema, password: passwordSchema }).strict();
export const loginSchema = z
  .object({ email: emailSchema, password: z.string().min(1).max(200) })
  .strict();

export const viewSchema = z
  .object({ yaw, pitch, fov: z.number().finite().min(MIN_FOV).max(MAX_FOV) })
  .strict();
export type View = z.infer<typeof viewSchema>;

export const createTourSchema = z.object({ title: z.string().trim().min(1).max(120) }).strict();

export const updateTourSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000),
    visibility: z.enum(TOUR_VISIBILITIES),
    startSceneId: uuid.nullable(),
    startView: viewSchema.nullable(),
  })
  .partial()
  .strict();

export const presignUploadSchema = z
  .object({
    tourId: uuid,
    filename: z.string().trim().min(1).max(255),
    contentType: z.enum(ALLOWED_UPLOAD_TYPES),
    size: z.number().int().positive(),
  })
  .strict();

/** Floor-plan pin, as a fraction of the plan's width/height. */
const mapCoord = z.number().finite().min(0).max(1);

export const updateSceneSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    startView: viewSchema.nullable(),
    northOffset: yaw,
    mapX: mapCoord.nullable(),
    mapY: mapCoord.nullable(),
  })
  .partial()
  .strict()
  .refine((v) => (v.mapX === undefined) === (v.mapY === undefined), {
    message: 'mapX and mapY must be set together',
  });

export const reorderScenesSchema = z.object({ sceneIds: z.array(uuid).min(1).max(1000) }).strict();

/** `missing` only adds absent next/back arrows; `rebuild` also removes ones that break the order. */
export const linkInOrderSchema = z
  .object({ mode: z.enum(['missing', 'rebuild']).default('missing') })
  .strict();

export const deleteSceneQuerySchema = z
  .object({ relink: z.enum(['0', '1']).optional() })
  .passthrough();

const navigationHotspotSchema = <K extends 'next' | 'back' | 'link'>(kind: K) =>
  z
    .object({
      kind: z.literal(kind),
      yaw,
      pitch,
      targetSceneId: uuid,
      title: z.string().trim().max(120).default(''),
    })
    .strict();

const infoHotspotSchema = z
  .object({
    kind: z.literal('info'),
    yaw,
    pitch,
    title: z.string().trim().min(1).max(120),
    text: z.string().trim().max(2000).default(''),
    imageUrl: httpUrlSchema.nullable().default(null),
  })
  .strict();

const hotspotUnion = z.discriminatedUnion('kind', [
  navigationHotspotSchema('next'),
  navigationHotspotSchema('back'),
  navigationHotspotSchema('link'),
  infoHotspotSchema,
]);

/** Older clients sent `type` instead of `kind`; a missing kind means "link". */
function withLegacyKind(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const { type, ...rest } = input as Record<string, unknown>;
  if (rest.kind !== undefined) return type === undefined ? input : rest;
  return { ...rest, kind: type ?? 'link' };
}

export const createHotspotSchema = z.preprocess(withLegacyKind, hotspotUnion);

export const floorPlanPresignSchema = z
  .object({
    contentType: z.literal('image/webp'),
    size: z.number().int().positive(),
  })
  .strict();

export const floorPlanCompleteSchema = z
  .object({
    key: z.string().regex(/^processed\/plans\/[0-9a-f-]{36}\/[A-Za-z0-9_-]{8,32}\.webp$/),
    width: z.number().int().min(16).max(10_000),
    height: z.number().int().min(16).max(10_000),
  })
  .strict();

export const autoLinkNearbySchema = z
  .object({ neighbors: z.number().int().min(1).max(4).default(2) })
  .strict();

export const updateHotspotSchema = z
  .object({
    yaw,
    pitch,
    title: z.string().trim().max(120),
    text: z.string().trim().max(2000),
    imageUrl: httpUrlSchema.nullable(),
    targetSceneId: uuid,
  })
  .partial()
  .strict();

export const uuidParamSchema = z.object({ id: uuid });
export const shareIdParamSchema = z.object({ shareId: z.string().regex(/^[A-Za-z0-9_-]{6,32}$/) });

export type SignupInput = z.infer<typeof signupSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type CreateTourInput = z.infer<typeof createTourSchema>;
export type UpdateTourInput = z.infer<typeof updateTourSchema>;
export type PresignUploadInput = z.infer<typeof presignUploadSchema>;
export type UpdateSceneInput = z.infer<typeof updateSceneSchema>;
export type ReorderScenesInput = z.infer<typeof reorderScenesSchema>;
export type CreateHotspotInput = z.input<typeof hotspotUnion>;
export type LinkInOrderInput = z.input<typeof linkInOrderSchema>;
export type UpdateHotspotInput = z.infer<typeof updateHotspotSchema>;
