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

export const updateSceneSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    startView: viewSchema.nullable(),
    northOffset: yaw,
  })
  .partial()
  .strict();

export const reorderScenesSchema = z.object({ sceneIds: z.array(uuid).min(1).max(1000) }).strict();

const linkHotspotSchema = z
  .object({
    type: z.literal('link'),
    yaw,
    pitch,
    targetSceneId: uuid,
    title: z.string().trim().max(120).default(''),
  })
  .strict();

const infoHotspotSchema = z
  .object({
    type: z.literal('info'),
    yaw,
    pitch,
    title: z.string().trim().min(1).max(120),
    text: z.string().trim().max(2000).default(''),
    imageUrl: httpUrlSchema.nullable().default(null),
  })
  .strict();

export const createHotspotSchema = z.discriminatedUnion('type', [
  linkHotspotSchema,
  infoHotspotSchema,
]);

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
export type CreateHotspotInput = z.input<typeof createHotspotSchema>;
export type UpdateHotspotInput = z.infer<typeof updateHotspotSchema>;
