import {
  type AnyPgColumn,
  bigint,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { HOTSPOT_TYPES, SCENE_STATUSES, TOUR_VISIBILITIES, type View } from '@btv/shared';

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const tourVisibility = pgEnum('tour_visibility', TOUR_VISIBILITIES);
export const sceneStatus = pgEnum('scene_status', SCENE_STATUSES);
export const hotspotType = pgEnum('hotspot_type', HOTSPOT_TYPES);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Always stored lower-cased and trimmed. */
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    /** Plan key, see packages/core/src/plans.ts. Billing will update this column. */
    plan: text('plan').notNull().default('free'),
    ...timestamps,
  },
  (t) => [uniqueIndex('users_email_key').on(t.email)],
);

export const sessions = pgTable(
  'sessions',
  {
    /** SHA-256 of the session token; the raw token only ever lives in the user's cookie. */
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sessions_user_idx').on(t.userId), index('sessions_expires_idx').on(t.expiresAt)],
);

export const tours = pgTable(
  'tours',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Short, unguessable id used in public links (/t/:shareId, /embed/:shareId). */
    shareId: text('share_id').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    visibility: tourVisibility('visibility').notNull().default('private'),
    startSceneId: uuid('start_scene_id').references((): AnyPgColumn => scenes.id, {
      onDelete: 'set null',
    }),
    startView: jsonb('start_view').$type<View>(),
    viewCount: integer('view_count').notNull().default(0),
    ...timestamps,
  },
  (t) => [uniqueIndex('tours_share_id_key').on(t.shareId), index('tours_owner_idx').on(t.ownerId)],
);

export const scenes = pgTable(
  'scenes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tourId: uuid('tour_id')
      .notNull()
      .references(() => tours.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    position: integer('position').notNull().default(0),
    status: sceneStatus('status').notNull().default('pending'),
    /** 0-100, updated by the worker. */
    progress: integer('progress').notNull().default(0),
    error: text('error'),
    originalKey: text('original_key').notNull(),
    contentType: text('content_type').notNull(),
    /** Size declared at presign time, replaced by the real object size on completion. */
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    width: integer('width'),
    height: integer('height'),
    /** Widths of the WebP variants available under processed/<sceneId>/. */
    variants: jsonb('variants').$type<number[]>().notNull().default([]),
    /** Tiny blurred WebP as a data: URL, shown instantly while the real image loads. */
    placeholder: text('placeholder'),
    thumbKey: text('thumb_key'),
    startView: jsonb('start_view').$type<View>(),
    /** Yaw (degrees) that points north; used by the compass. */
    northOffset: real('north_offset').notNull().default(0),
    queuedAt: timestamp('queued_at', { withTimezone: true }),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('scenes_tour_position_idx').on(t.tourId, t.position),
    index('scenes_status_updated_idx').on(t.status, t.updatedAt),
  ],
);

export const hotspots = pgTable(
  'hotspots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sceneId: uuid('scene_id')
      .notNull()
      .references(() => scenes.id, { onDelete: 'cascade' }),
    type: hotspotType('type').notNull(),
    yaw: real('yaw').notNull(),
    pitch: real('pitch').notNull(),
    /** Link hotspots are removed together with the scene they point to. */
    targetSceneId: uuid('target_scene_id').references(() => scenes.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default(''),
    text: text('text').notNull().default(''),
    imageUrl: text('image_url'),
    ...timestamps,
  },
  (t) => [index('hotspots_scene_idx').on(t.sceneId)],
);

/** Privacy-friendly analytics: one aggregated counter per tour per day, no personal data. */
export const tourViewsDaily = pgTable(
  'tour_views_daily',
  {
    tourId: uuid('tour_id')
      .notNull()
      .references(() => tours.id, { onDelete: 'cascade' }),
    day: date('day', { mode: 'string' }).notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.tourId, t.day] })],
);

export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type TourRow = typeof tours.$inferSelect;
export type SceneRow = typeof scenes.$inferSelect;
export type HotspotRow = typeof hotspots.$inferSelect;
