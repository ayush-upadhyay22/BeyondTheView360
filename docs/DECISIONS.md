# Architecture & product decisions

A running log of decisions made while building BeyondTheView360. Each entry states the
decision, the reason, and (where relevant) how to revisit it.

## Phase 1 — Monorepo & tooling

**D1. Replace the single-file prototype.** The repository started with a small Express + SQLite
prototype (`server.js`, `public/index.html`). It was removed in favour of the monorepo; it remains
in git history (commit `255989c`) as a reference for the original viewer maths.

**D2. Extra workspace `packages/core`.** The spec lists `apps/web`, `apps/api`, `apps/worker` and
`packages/shared`. The API and worker also share server-only code (config parsing, Drizzle schema,
storage drivers, queue definitions, logger). Putting that in `packages/shared` would pull the AWS
SDK, `pg` and BullMQ into the browser bundle's dependency graph, so it lives in a separate
server-only package `@btv/core`. `@btv/shared` stays browser-safe (types, zod schemas, pure maths).

**D3. Workspace packages export TypeScript source.** `@btv/shared` and `@btv/core` point `exports`
at `src/index.ts`. Vite, Vitest and `tsx` consume TS directly, and the API/worker production builds
are bundled by `tsup` (esbuild) which inlines workspace packages while keeping `node_modules`
external. This avoids project-reference build ordering and keeps `npm run dev` instant.

**D4. Pinned dependency versions.** All dependencies use exact versions (no `^`) so builds are
reproducible; `package-lock.json` is committed. Three.js is pinned to `0.170.0`. Well-known major
versions were preferred over the very newest majors (e.g. BullMQ 5, ioredis 5, zod 3, React 18,
Tailwind 3, Express 5) for API stability.

**D5. Env loading without dotenv.** Node ≥ 20.12 ships `process.loadEnvFile`. Each server app
loads `.env` if present; otherwise, **only outside production**, it falls back to the committed
`.env.example` so a fresh clone runs with zero copying. In production every value must come from
the real environment and config validation (zod) fails fast on anything missing.

**D6. Local infra only in Docker.** `docker-compose.yml` runs Postgres, Redis and MinIO; the three
apps run on the host via `npm run dev` (fast reloads, easy debugging). `npm run docker:up` starts
the services with `--wait` and then runs the one-shot `minio-init` job explicitly (some Compose
versions treat an exited one-shot container as a `--wait` failure).

**D7. MinIO CORS.** MinIO historically applies CORS server-wide (`MINIO_API_CORS_ALLOW_ORIGIN`)
and older builds reject `PutBucketCors`. Compose sets the server-wide allowlist and the init job
also attempts `mc cors set` with `docker/minio-cors.json` (the same JSON works for AWS S3).

**D8. CI.** Two jobs: (1) lint, prettier check, typecheck, unit tests and build; (2) integration
tests against real Postgres/Redis/MinIO containers. MinIO is started with `docker run` because
GitHub service containers cannot override the image command.

## Phase 2 — Database & auth

**D9. Drizzle ORM + drizzle-kit.** Schema lives in `packages/core/src/db/schema.ts`; SQL
migrations are generated with `npm run db:generate` and committed under `packages/core/drizzle`.
`npm run db:migrate` applies them with Drizzle's migrator (no drizzle-kit needed at runtime).
`drizzle-orm` is also a root devDependency so npm hoists it next to `drizzle-kit` (otherwise npm
nests it because of its long optional peer list and drizzle-kit cannot find it).

**D10. Server-side sessions instead of JWT.** A random 256-bit token is stored in an `httpOnly`,
`SameSite=Lax`, `Secure` (in production) cookie; only its SHA-256 hash is stored in the `sessions`
table. This makes logout/revocation immediate, needs no signing secret, and a leaked database does
not leak usable tokens. Sessions are rotated on login (prevents fixation) and expire after
`SESSION_TTL_DAYS`.

**D11. CSRF.** Defence in depth: `SameSite=Lax` cookies, plus every non-GET request must carry
the custom header `x-btv-csrf: 1` (cross-site forms cannot set it; cross-origin `fetch` would
need a CORS preflight that only allowlisted origins pass), plus an `Origin` allowlist check.

**D12. Passwords.** argon2id via `@node-rs/argon2` (prebuilt N-API binaries, no node-gyp) with
OWASP minimum parameters. Logins for unknown emails still run a dummy verification so timing does
not reveal which accounts exist. Minimum password length is 10.

**D13. Ownership failures return 404.** Accessing another user's tour/scene/hotspot returns
"not found" rather than 403 so ids of other users' content cannot be probed.

**D14. Emails** are trimmed and lower-cased before storage and lookup (unique index on the
normalised value).

**D15. Rate limiting** uses `express-rate-limit` with its in-memory store: auth 30 / 15 min / IP,
uploads 200 / 15 min / user, public view pings 60 / min / IP, everything else 600 / min / IP.
With several API replicas, swap in a Redis store (`rate-limit-redis`) — marked as an extension
point in `apps/api/src/middleware.ts`.

## Phase 3 — Storage & presigned uploads

**D16. Storage interface.** `StorageDriver` (`packages/core/src/storage/types.ts`) exposes
`put`, `get`, `head`, `delete`, `presignUpload` and `publicUrl`. `head` was added to the five
required methods because `/scenes/:id/complete` must verify the object exists without downloading
it. Drivers: `s3` (production; MinIO and AWS differ only by env vars) and `memory` (tests). New
drivers register in `createStorage` — the marked extension point.

**D17. Presigned POST, not presigned PUT.** Only POST policies can enforce
`content-length-range` server-side, so oversized uploads are rejected by S3 itself. The policy also
pins the exact key and `Content-Type`. The file never touches the API.

**D18. Object keys contain no user input.** `originals/<sceneId>/original` and
`processed/<sceneId>/<width>.webp | thumb.jpg`. Filenames are only used to derive a display name.
Keys are validated by `assertSafeKey` in every driver call.

**D19. Stable signed URLs.** Signed GET URLs are signed with a timestamp rounded down to half the
TTL, so repeated API responses return identical URLs for a while. Browsers can cache images and
the viewer does not reload textures on every poll, while every URL still has ≥ TTL/2 validity.
Setting `PUBLIC_BASE_URL` switches to plain CDN URLs (bucket stays private behind e.g. CloudFront
OAC).

**D20. Scene lifecycle starts at presign.** `POST /scenes/presign` creates the scene row in
`pending` (so plan limits count in-flight uploads and the UI can show it immediately).
`/complete` moves it to `queued` exactly once (conditional update) and is idempotent. If Redis is
unavailable at that moment the scene stays `queued` and the worker's stuck-scene sweeper enqueues
it later, so no upload is lost. Failed scenes can be re-queued via `POST /scenes/:id/retry`.

**D21. Plan-limit errors use HTTP 402** (`code: "plan_limit"`) so the UI can show an upgrade
hint; too-large files use 413 (`file_too_large`).

**D22. Best-effort object deletion.** Deleting a scene/tour removes DB rows first (cascades take
care of hotspots and links), then deletes objects asynchronously; failures are logged and never
block the user. Orphans are harmless because keys are never reused.

**D23. Single-object deletes.** Batch `DeleteObjects` requires `Content-MD5` on some
S3-compatible stores (including the pinned MinIO release), which recent AWS SDKs no longer send.
The S3 driver therefore issues `DeleteObject` calls with bounded concurrency (8). Scenes have
fewer than ten objects, so the cost is negligible.

## Phase 4 — Queue, worker & image pipeline

**D24. Idempotent jobs.** The BullMQ job id is `scene-<sceneId>`, so double enqueues are ignored.
The processor skips scenes that are already `ready`, deleted, or not yet uploaded; object writes
are overwrites of deterministic keys. Producers remove a _finished_ job with the same id before
re-adding it so retries work.

**D25. Permanent vs transient failures.** Validation problems throw `PermanentError`; the
processor marks the scene `failed` with the (user-friendly) message and rethrows BullMQ's
`UnrecoverableError`, so the job fails at once with no retries. Other errors are retried
(`JOB_ATTEMPTS`, exponential backoff from `JOB_BACKOFF_MS`); between attempts the scene shows
`queued`, and after the last attempt it becomes `failed` with a generic "try again" message.
libvips decode errors (truncated/corrupt files) count as permanent; out-of-memory does not.

**D26. Dead letters.** Failed jobs are kept in BullMQ's failed set for 30 days _and_ a summary is
copied to the `scene-processing-dead-letter` queue and logged at `error` level, so they can be
inspected (e.g. with Bull Board / redis-cli) or replayed.

**D27. Stuck-job recovery.** Two layers: BullMQ stalled-job detection (a crashed worker's job is
re-queued after 30 s, up to 2 times), plus a sweeper in every worker (startup + every
`SWEEP_INTERVAL_SECONDS`) that re-enqueues scenes left in `queued`/`processing` for longer than
`STUCK_SCENE_MINUTES` without a live job, and deletes `pending` uploads that never completed
after `PENDING_UPLOAD_TTL_HOURS`. Multiple workers sweeping concurrently is safe thanks to D24.

**D28. Image pipeline.** Magic bytes are checked first (JPEG/PNG/WebP only; the declared
`Content-Type` is not trusted), then sharp metadata must agree with the detected format. EXIF
orientation is applied before validation and baked into pixels. Variants are produced from the
original for each width ≤ original (resized to exactly 2:1), as WebP; plus a 320×160 mozjpeg
thumbnail and a 48×24 blurred WebP placeholder (stored in S3 and inlined in the DB as a data URL
for instant display). sharp drops all metadata (EXIF, GPS, XMP) by default; a unit test asserts
it. `limitInputPixels` guards against decompression bombs. `sharp.concurrency` is divided by the
job concurrency to avoid oversubscribing CPUs.

**D29. Queue prefix.** `QUEUE_PREFIX` namespaces BullMQ keys so several environments (or test
runs) can share one Redis without stealing each other's jobs.

**D30. Production bundles.** `tsup` bundles each server app with the workspace packages inlined
and every npm dependency (including those of `@btv/core`) left external, giving a single
`dist/server.js` / `dist/main.js` that runs with `node` against `node_modules`.

## Phase 5 — Viewer

**D31. Own viewer engine on plain Three.js.** `PanoramaEngine` is a small framework-free class
(sphere + perspective camera, ~600 lines) rather than a third-party panorama library. It owns
input (pointer drag with inertia, pinch, wheel, keyboard via the React wrapper), autorotate, gyro,
stereo split rendering and texture loading. React (`TourPlayer`) only handles UI state. The render
loop is dirty-flag driven, so an idle viewer costs ~no GPU time.

**D32. Yaw/pitch convention.** Yaw 0 is the horizontal centre of the equirectangular image and
looks down −Z; positive yaw turns right; pitch is positive upward; degrees everywhere in the API.
The sphere is mirrored (`scale(-1,1,1)`) so the image is seen un-mirrored from inside, and rotated
by −90° so the image centre sits at yaw 0. The same maths lives in `@btv/shared/geometry` and is
unit-tested, so editor clicks, stored hotspots and the viewer always agree.

**D33. North offset and heading-preserving navigation.** Each scene stores `northOffset` (the yaw
that faces real north). When following a link, the viewer keeps the user's compass heading across
scenes (`newYaw = oldYaw − oldNorth + newNorth`) unless the target scene has an explicit start view.

**D34. Progressive loading.** Show the inline blurred placeholder immediately, then the variant
picked by `selectVariant` (≈2048 on phones, 4096 on desktop, 8192 on ≥3840 physical px or when the
user presses HD), capped by `gl.MAX_TEXTURE_SIZE`. Textures are cached in a small LRU (5) keyed by
`sceneId:width` — not by URL, because signed URLs change — and linked scenes are preloaded.

**D35. Hotspots are DOM elements.** Markers are real `<button>`s repositioned every frame by
writing `transform` directly (no React re-render), which gives keyboard focus, aria-labels, hover
labels and easy drag-to-move in the editor for free. In stereo (VR) mode DOM can't be split per
eye, so the engine renders sprite markers instead and activates a hotspot after a 1.5 s gaze dwell.

**D36. Accessibility and motion.** Autorotate is off when `prefers-reduced-motion` is set and stops
on the first interaction. Every control has an aria-label; the stage is focusable with arrow keys
(Shift = bigger steps) and +/−. Gyro uses `DeviceOrientationEvent.requestPermission()` on iOS from
a user gesture; fullscreen falls back to a fixed-position pseudo-fullscreen where the API is
missing (iPhone Safari).

**D37. Production web server and CSP.** `apps/web/server/serve.ts` (Express + helmet) serves the
built SPA with a strict CSP (`script-src 'self'`, no inline scripts; inline _style attributes_ are
allowed because markers are positioned with them). `frame-ancestors` is `'self'` everywhere except
`/embed/*`, which uses `EMBED_FRAME_ANCESTORS` (default `*`). Media origins (S3/CDN) are added to
`img-src`/`connect-src` via `CSP_MEDIA_ORIGINS`. Hashed assets are `immutable`; `index.html` is
`no-cache`. An optional `/api` proxy lets the web container front the API without a load balancer.
The Vite dev server mirrors the framing rules.

**D38. Web unit tests use their own Vitest config.** The root Vitest (2.x) ships Vite 5 while the
app builds with Vite 6; `vitest.config.ts` avoids loading the app's Vite plugins, and
`vite.config.ts` is left out of the app `tsc` project to avoid the duplicate-type clash.

## Phase 6 — Editor and dashboard

**D39. Server state lives in TanStack Query; edits are optimistic.** Every editor mutation goes
through one helper (`useTourMutation`) that patches the cached `TourDTO` immediately, rolls back
on error and refetches afterwards, so the UI never waits for the network and always converges on
server truth. All edits share a mutation key, which drives the "Saving… / All changes saved /
Not saved: …" indicator.

**D40. Autosave instead of save buttons.** Text fields save 600 ms after the user stops typing and
flush on unmount (switching hotspot or leaving the page never drops an edit). Invalid drafts (empty
required title, non-http image URL) are shown inline and simply not sent.

**D41. Upload queue in the browser.** Files are pre-checked (type, size, remaining scene quota),
then uploaded three at a time straight to storage with `XMLHttpRequest` (fetch has no upload
progress). Presign calls are serialised so scene order matches the order files were dropped; the
storage POSTs run in parallel. Uploads can be cancelled, and leaving the page mid-upload warns.
Processing progress then comes from polling the tour every 1.5 s while any scene is busy.

**D42. Hotspot placement and editing.** "Add link"/"Add info" arm a placement mode; the next click
in the panorama (not a drag) creates the hotspot at that yaw/pitch and opens it in the inspector.
Markers are dragged to move (optimistic PATCH on drop); clicking a marker in the editor selects
instead of navigating. "Scene starts here", "North is here" and "Tour starts here" capture the
live camera view, so authors set orientation by looking rather than typing angles.

**D43. Reordering.** Native HTML drag-and-drop on the scene list plus explicit up/down buttons for
keyboard and touch users; both send the full ordered id list (`PUT /tours/:id/scenes/order`).

**D44. Share snippet.** The iframe snippet uses the `/embed/:shareId` route with `allow="fullscreen;
gyroscope; accelerometer; xr-spatial-tracking"` so VR/gyro work when embedded; the title is
attribute-escaped (unit-tested). Private tours show a warning that the links only work for the
owner.

## Phase 7 — Public page, embed, analytics

**D45. One public endpoint for page and embed.** `GET /api/public/tours/:shareId` returns a
`PublicTourDTO` with only ready scenes and only links between ready scenes; no owner ids, emails
or storage keys. Share ids are random 10-char ids (not the tour UUID) validated by regex. Private
tours return 404 for everyone except their owner (who sees a banner), matching the
"404 instead of 403" rule. Responses are `Cache-Control: private, no-store` because they contain
signed URLs; the client refreshes them every 10 minutes, well inside the URL TTL.

**D46. Privacy-friendly view counting.** `POST /api/public/tours/:shareId/views` increments
`tours.view_count` and an aggregate `tour_views_daily` row in one transaction. No cookies, IPs,
user agents or visitor ids are stored; the browser dedupes with `sessionStorage` (one view per tab
session) and the endpoint is rate-limited per IP in memory only. Owners' own views are not
counted. The editor shows total and a 30-day bar chart.

**D47. Embedding.** `/embed/:shareId` is a chrome-less page (no site header/footer) with the full
viewer controls and a small link back to the public page. It is the only route served with a
permissive `frame-ancestors` (see D37); every other page sends `frame-ancestors 'self'` and
`X-Frame-Options: SAMEORIGIN`. Session cookies are `SameSite=Lax`, so inside third-party iframes
the viewer is always anonymous — private tours therefore cannot be embedded, which is intended.

## Phase 8 — Samples, seed, docs

**D48. Synthetic samples rendered locally.** `samples:generate` draws original equirectangular
scenes (courtyard, gallery, rooftop) as SVG and rasterises them with sharp, so no images are
downloaded or copied and the command works offline. One sample per format (JPEG, PNG, WebP)
exercises every decoder; a 4:1 `invalid-wide-strip.jpg` exercises the rejection path. Compass
labels put north at yaw 0 so orientation bugs are visible. Output goes to the git-ignored
`samples/` folder.

**D49. Seed is idempotent and refuses production.** `db:seed` upserts `demo@example.com`
(password documented in the README, overridable via `DEMO_PASSWORD`) and an unlisted demo tour
with the fixed share id `demo-tour-360`, so the demo URL is stable across resets. It exits in
`NODE_ENV=production` unless `ALLOW_SEED=1`.

**D50. `samples:upload` uses the real public API.** It logs in, presigns, POSTs each file to
storage, calls `/complete` and polls exactly like the browser, so it doubles as an end-to-end
smoke test. Already-uploaded scene names are skipped (safe to rerun). Ready scenes are linked in a
ring (forward at yaw 0, back at yaw 180) with one info hotspot each, and the first becomes the
start scene.

**D51. Out-of-scope features are marked in code.** Payments, custom domains, floor plans, AI
enhancement, mobile app and extra storage drivers each have an `EXTENSION POINT` comment where
they would plug in; the README roadmap lists them.

## Phase 9 — Final check

**D52. Fresh-clone verification.** The documented path (clone → `npm install` → infra →
`db:migrate && db:seed` → `samples:generate` → `dev` → `samples:upload`) was run from a clean
clone against an empty database: 3 sample scenes became ready, the invalid one was rejected with
its message, and `/t/demo-tour-360` rendered the linked tour. Lint, format check, typecheck, unit
tests, integration tests and the production build all passed from the same clone. Docker was not
available on the verification machine, so Postgres 16, Redis 7 and MinIO ran natively with the
same ports, credentials and CORS settings as `docker-compose.yml`. npm 11 may print an
"install-scripts" notice for sharp/esbuild; both work from their prebuilt platform packages, so
no action is needed.

## Walk-through tours

**D53. Scene position is max + 1.** `presign` locks the tour row, then sets `position` to
`max(position) + 1`. Row counts are never used: deletes leave gaps so a new upload always sorts
after every surviving scene.

**D54. Hotspot `kind` with a legacy column name.** The column stays `type` so existing rows keep
working. Allowed values are `next`, `back`, `link`, `info`; a missing kind (or a body that still
sends `type`) is treated as `link`. A partial unique index on `(scene, kind, target)` for
next/back makes auto-linking idempotent. Max 50 hotspots per scene.

**D55. Auto-link in the same transaction as the insert.** After the new scene row is written,
`appendToChain` adds previous→next (yaw 0, pitch −0.3 rad) and new→back (yaw π, pitch −0.3 rad)
unless the previous scene is already at the hotspot limit. Rejected or abandoned uploads are
bridged out of the chain by the worker so a bad photo does not break the walk.

**D56. Link-in-order is a plan, then a write.** `planChain` (shared, unit-tested) computes the
add/remove set. `missing` only inserts absent next/back arrows; `rebuild` also deletes ones that
no longer match the order. Custom `link` and `info` hotspots are never touched. The editor offers
both after a reorder.

**D57. Walking transition.** Shared timing helpers (`walkOutPose` / `walkInPose`) turn the
shortest way, dip the pitch, zoom the FOV by 22° and fade to black in 450 ms, wait until the
next texture is decoded, swap, then restore. Reduced motion is a plain fade. Arrival yaw keeps
the compass heading (`walkYaw − fromNorth + toNorth`). Only one walk runs at a time.

**D58. Guided walk.** “Walk through” dwells 3.5 s with a slow autorotate, then follows the
current scene’s `next` arrow. It restarts from the first room if started on the last one, and
stops after the last room or on any user drag, click or key. `?scene=`, `?autoplay=1` and
`?ui=0` are parsed once and work on the public page and the embed.

**D59. Floor-plan pins.** Optional WebP plan per tour; pins are fractions 0…1. Bearings are
clockwise from plan-up, corrected for the plan’s aspect ratio and the scene’s north offset.
“Auto-link nearby” inserts `link` hotspots toward the k nearest pinned neighbours without
removing anything.
