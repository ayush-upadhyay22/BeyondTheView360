# BeyondTheView360

**Step inside every space.** BeyondTheView360 is a self-hostable platform for building and
sharing 360° virtual tours: upload equirectangular photos, link them with hotspots, and publish a
tour as a share link or an `<iframe>` embed.

- **Walk-through** — rooms uploaded in order are auto-linked with floor arrows; visitors walk
  from room to room with a short turn-and-zoom, or press **Walk through** for a guided tour.
- **Editor** — drag-and-drop multi-upload with progress, live processing status, scene
  ordering/renaming, drag arrows onto doors, click-to-place link and info hotspots, start view
  and north from the live camera, optional floor-plan pins, autosave.
- **Viewer** — Three.js, drag/inertia, wheel and pinch zoom, autorotate (respects reduced
  motion), fullscreen, gyroscope (incl. iOS permission), VR split-screen with gaze activation,
  progressive loading (blurred placeholder → right-sized variant → optional 8K), keyboard control.
- **Sharing** — private / unlisted / public tours, `/t/:id` public pages, `/embed/:id` for other
  sites, privacy-friendly view counts.
- **Pipeline** — browser uploads straight to S3 via presigned POST; a BullMQ worker validates,
  strips EXIF/GPS and renders WebP variants with sharp, with retries, a dead-letter queue and
  stuck-job recovery.

---

## Contents

[Architecture](#architecture) · [Stack](#stack) · [Prerequisites](#prerequisites) ·
[Quick start](#quick-start) · [Walk-through tours](#walk-through-tours) · [Testing with images](#testing-with-images) ·
[Configuration](#configuration) · [Project layout](#project-layout) · [API](#api) ·
[Scripts](#scripts) · [Testing](#testing) · [Troubleshooting](#troubleshooting) ·
[Deploying to production](#deploying-to-production) · [Roadmap](#roadmap)

## Architecture

```text
                ┌──────────────────────────── browser ────────────────────────────┐
                │  React SPA (editor, dashboard, /t/:id, /embed/:id)               │
                │  Three.js viewer                                                 │
                └───────┬───────────────────────────────┬──────────────▲──────────┘
         JSON + cookie  │ /api/*                        │ presigned    │ signed GET
                        ▼                               │ POST upload  │ (or CDN)
   ┌──────────────────────────────┐                     ▼              │
   │  API  (Express, zod, helmet) │  presign / head ┌────────────────────────────┐
   │  auth · tours · scenes ·     │────────────────▶│  S3-compatible storage     │
   │  hotspots · public · stats   │                 │  (MinIO locally, AWS S3)   │
   └───────┬──────────────┬───────┘                 │  originals/<id>/original   │
           │ SQL          │ enqueue                 │  processed/<id>/*.webp     │
           ▼              ▼                         └────────────▲───────────────┘
   ┌──────────────┐  ┌──────────────┐   jobs   ┌──────────────┐  │ get / put
   │  PostgreSQL  │◀─│ Redis/BullMQ │─────────▶│   Worker     │──┘
   │  (Drizzle)   │  └──────────────┘          │ sharp: verify│
   └──────▲───────┘                            │ strip, resize│
          └────────────── status/progress ─────┴──────────────┘
```

Upload flow: `POST /api/scenes/presign` → the browser POSTs the file **directly to storage**
(policy enforces exact content type and size) → `POST /api/scenes/:id/complete` verifies the
object and enqueues a job → the worker moves the scene `queued → processing → ready | failed`
while the editor polls.

Design decisions and their reasoning are recorded in [`docs/DECISIONS.md`](docs/DECISIONS.md).

## Stack

| Layer      | Choice                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------- |
| Monorepo   | npm workspaces, TypeScript strict, ESLint (flat config), Prettier                                 |
| Web        | React 18, Vite 6, Tailwind CSS 3, React Router 6, TanStack Query 5, Three.js 0.170 (pinned)       |
| API        | Node 20, Express 5, zod, helmet, CORS allowlist, express-rate-limit, pino                         |
| Data       | PostgreSQL 16 with Drizzle ORM + SQL migrations                                                   |
| Jobs       | BullMQ on Redis 7                                                                                 |
| Images     | sharp (libvips) in the worker                                                                     |
| Storage    | `StorageDriver` interface with an `s3` driver (MinIO locally, AWS S3 in production)               |
| Auth       | email + password (argon2id), server-side sessions in httpOnly cookies, CSRF header + origin check |
| Tests / CI | Vitest (unit + integration), GitHub Actions                                                       |

## Prerequisites

- **Node.js 20.12+** (see `.nvmrc`) and npm 10+
- **Docker Desktop** (or any Docker Engine with Compose v2) for Postgres, Redis and MinIO
- Free ports: `5173` (web), `4000` (API), `5432`, `6379`, `9000`/`9001` (MinIO API/console)

Everything runs offline after `npm install` and the first `docker compose` image pull.

## Quick start

```bash
git clone https://github.com/ayush-upadhyay22/BeyondTheView360.git
cd BeyondTheView360
npm install
npm run docker:up                     # Postgres, Redis, MinIO + bucket/CORS setup
npm run db:migrate && npm run db:seed # schema + demo user and tour
npm run samples:generate              # synthetic test panoramas into ./samples
npm run dev                           # API :4000, worker, web :5173 (leave running)
# in a second terminal:
npm run samples:upload                # uploads ./samples to the demo tour via the real API
```

Open <http://localhost:5173/t/demo-tour-360> for the demo tour, or log in at
<http://localhost:5173/login> with:

| Email              | Password               |
| ------------------ | ---------------------- |
| `demo@example.com` | `beyond-the-view-demo` |

No `.env` files are needed for local development: each app falls back to its `.env.example`
(only when `NODE_ENV` is not `production`). Copy `.env.example` to `.env` in an app folder to
override values. MinIO's console is at <http://localhost:9001> (`btvminio` /
`btv_minio_local_secret`, local only).

`/demo` shows the viewer with two panoramas drawn in the browser, without any backend.

## Walk-through tours

Upload rooms **in the order a visitor should walk them**. Each new photo is automatically
connected to the previous one:

- the previous room gets a floor **next** arrow (yaw 0, slightly below the horizon)
- the new room gets a floor **back** arrow (yaw 180)

Name files so they sort the way you want them walked (`01-hall.jpg`, `02-kitchen.jpg`,
`03-bedroom.jpg`). The editor uploads one file after another in the order you selected or
dropped; a file-picker that re-sorts alphabetically can change that order, so numbered
prefixes are the reliable fix.

After upload:

1. Drag each floor arrow onto the doorway it leads through (a drag never walks).
2. Drag a scene thumbnail from the list onto the view to add a labelled jump to another room.
3. Use **Link all scenes in order** to fill any missing next/back arrows without touching
   custom links. After a reorder, **Re-link in order** rebuilds the chain to match the list.
4. Visitors click an arrow to walk: the camera turns toward it, zooms in, fades, and arrives
   facing the same way. **Walk through** stays in each room for a few seconds, then follows
   the next arrows to the end. Any drag, click or key press stops it.

Share and embed query params (also available as checkboxes in the share dialog):

| Param         | Effect                                                     |
| ------------- | ---------------------------------------------------------- |
| `?scene=<id>` | Open on that scene                                         |
| `?autoplay=1` | Start the guided walk as soon as the first room is visible |
| `?ui=0`       | Hide every control (kiosk / background embeds)             |

Images should be **landscape 360°** photos (JPEG, PNG or WebP). True 2:1 equirectangular is
ideal; other landscapes from 1:1 to 24:1 — including phone pans — are letterboxed onto a 2:1
canvas. Small photos are upscaled to 2048 px wide. Portraits are rejected.

## Testing with images

- `npm run samples:generate` writes five original rooms (hall → kitchen → living → bedroom →
  garden), a Willow House floor plan, and one **invalid** portrait that the worker must reject.
  `npm run samples:upload -- --rebuild` rebuilds the demo tour, pins every room, and auto-links
  neighbours. Add `-- --width 8192` when generating for 8K images.
- Drop your own landscape 360° photos into [`samples/`](samples/) and run
  `npm run samples:upload`, or drag them into the editor.
- Phone cameras and most 360° cameras (Ricoh Theta, Insta360, GoPro Max) export equirectangular
  JPEGs that work as-is. EXIF/GPS metadata is stripped during processing.

## Configuration

Each app reads its own environment (`apps/<app>/.env`, falling back to `.env.example` in
development). Production must provide real values via the environment.

| Variable                                    | Used by              | Default (dev)             | Description                                                                               |
| ------------------------------------------- | -------------------- | ------------------------- | ----------------------------------------------------------------------------------------- |
| `NODE_ENV`                                  | api, worker          | `development`             | `production` enables secure cookies and disables `.env.example` fallback                  |
| `LOG_LEVEL`                                 | api, worker          | `info`                    | pino level                                                                                |
| `PORT`                                      | api                  | `4000`                    | API port                                                                                  |
| `DATABASE_URL`                              | api, worker          | local Postgres            | Postgres connection string                                                                |
| `REDIS_URL`                                 | api, worker          | `redis://localhost:6379`  | Redis for BullMQ (use `noeviction`)                                                       |
| `QUEUE_PREFIX`                              | api, worker          | `btv`                     | BullMQ key namespace; must match between API and worker                                   |
| `CORS_ORIGINS`                              | api                  | `http://localhost:5173,…` | Browser origins allowed to call the API with credentials                                  |
| `WEB_ORIGIN`                                | api                  | `http://localhost:5173`   | Public origin of the web app                                                              |
| `TRUST_PROXY`                               | api                  | `0`                       | Number of proxies in front of the API (client IPs for rate limiting)                      |
| `SESSION_TTL_DAYS`                          | api                  | `30`                      | Session lifetime                                                                          |
| `COOKIE_SECURE`                             | api                  | `false` (`true` in prod)  | `Secure` flag on the session cookie                                                       |
| `JSON_BODY_LIMIT`                           | api                  | `100kb`                   | Max JSON body size                                                                        |
| `RATE_LIMIT_ENABLED`                        | api                  | `true`                    | Disable only for tests                                                                    |
| `STORAGE_DRIVER`                            | api, worker          | `s3`                      | Storage driver (`s3`; tests inject an in-memory driver)                                   |
| `S3_BUCKET`                                 | api, worker          | `btv-media`               | Bucket name (private)                                                                     |
| `S3_REGION`                                 | api, worker          | `us-east-1`               | Region                                                                                    |
| `S3_ENDPOINT`                               | api, worker          | `http://localhost:9000`   | Custom endpoint (MinIO); **empty for AWS S3**                                             |
| `S3_PUBLIC_ENDPOINT`                        | api                  | = `S3_ENDPOINT`           | Endpoint as seen by browsers, if different                                                |
| `S3_FORCE_PATH_STYLE`                       | api, worker          | `true`                    | Path-style URLs (MinIO); `false` for AWS                                                  |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | api, worker          | MinIO dev keys            | **Empty in production** to use the IAM role                                               |
| `PUBLIC_BASE_URL`                           | api                  | empty                     | CDN origin for `processed/` objects; when set, images use CDN URLs instead of signed URLs |
| `SIGNED_URL_TTL_SECONDS`                    | api                  | `3600`                    | Lifetime of signed image URLs                                                             |
| `UPLOAD_URL_TTL_SECONDS`                    | api                  | `900`                     | Lifetime of presigned upload forms                                                        |
| `PLAN_FREE_MAX_TOURS`                       | api                  | `3`                       | Free plan: tours per user                                                                 |
| `PLAN_FREE_MAX_SCENES_PER_TOUR`             | api                  | `20`                      | Free plan: scenes per tour                                                                |
| `PLAN_FREE_MAX_UPLOAD_MB`                   | api                  | `100`                     | Free plan: max image size                                                                 |
| `JOB_ATTEMPTS` / `JOB_BACKOFF_MS`           | api, worker          | `3` / `5000`              | Retry policy (exponential backoff)                                                        |
| `WORKER_CONCURRENCY`                        | worker               | `2`                       | Jobs processed in parallel per worker                                                     |
| `MAX_INPUT_PIXELS`                          | worker               | `268435456`               | Decompression-bomb guard (width × height)                                                 |
| `STUCK_SCENE_MINUTES`                       | worker               | `15`                      | Re-enqueue scenes stuck in `queued`/`processing`                                          |
| `SWEEP_INTERVAL_SECONDS`                    | worker               | `60`                      | How often the sweeper runs                                                                |
| `PENDING_UPLOAD_TTL_HOURS`                  | worker               | `24`                      | Delete uploads that were presigned but never completed                                    |
| `VITE_API_BASE_URL`                         | web (build)          | `/api`                    | API base URL baked into the SPA                                                           |
| `VITE_API_PROXY_TARGET`                     | web (dev)            | `http://localhost:4000`   | Vite dev proxy target                                                                     |
| `WEB_PORT`                                  | web (prod server)    | `8080`                    | Port of `apps/web/server/serve.ts`                                                        |
| `API_PROXY_TARGET`                          | web (prod server)    | empty                     | Optional `/api` reverse proxy target                                                      |
| `CSP_MEDIA_ORIGINS`                         | web (prod server)    | `http://localhost:9000`   | S3/CDN origins added to the CSP                                                           |
| `EMBED_FRAME_ANCESTORS`                     | web (prod server)    | `*`                       | Who may iframe `/embed/*`                                                                 |
| `DEMO_EMAIL` / `DEMO_PASSWORD`              | seed, samples:upload | demo account              | Override the demo credentials                                                             |
| `API_URL` / `WEB_URL`                       | samples:upload       | `localhost`               | Target API / printed links                                                                |

## Project layout

```text
apps/
  api/          Express API — src/routes, src/services (ownership, DTOs), scripts (seed, samples:upload)
  worker/       BullMQ worker — src/image (validation, sharp pipeline), scripts/generate-samples.ts
  web/          React SPA — src/viewer (Three.js engine), src/editor, src/pages; server/serve.ts (prod)
packages/
  shared/       Browser-safe: zod schemas, DTO types, constants, geometry, variant selection
  core/         Server-only: env, logger, Drizzle schema + migrations, storage drivers, queue, plans
docker/         MinIO CORS rules
docs/           DECISIONS.md, API.md
samples/        Test images (git-ignored)
docker-compose.yml   Postgres, Redis, MinIO, one-shot bucket/CORS setup
```

## API

All endpoints are under `/api`; see [`docs/API.md`](docs/API.md) for bodies, responses and errors.

| Area     | Endpoints                                                                                                                                                                   |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Health   | `GET /healthz`, `GET /readyz`                                                                                                                                               |
| Auth     | `POST /auth/signup`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`                                                                                                |
| Tours    | `GET/POST /tours`, `GET/PATCH/DELETE /tours/:id`, `PUT /tours/:id/scenes/order`, `POST /tours/:id/link-in-order`, floor-plan and nearby-link routes, `GET /tours/:id/stats` |
| Scenes   | `POST /scenes/presign`, `POST /scenes/:id/complete`, `POST /scenes/:id/retry`, `GET/PATCH/DELETE /scenes/:id`, `POST /scenes/:id/hotspots`                                  |
| Hotspots | `PATCH/DELETE /hotspots/:id`                                                                                                                                                |
| Public   | `GET /public/tours/:shareId`, `POST /public/tours/:shareId/views`                                                                                                           |

## Scripts

| Command                                                  | What it does                                                                            |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `npm run dev`                                            | API (watch), worker (watch) and Vite dev server together                                |
| `npm run docker:up` / `docker:down`                      | Start / stop Postgres, Redis, MinIO (and create the bucket + CORS)                      |
| `npm run docker:reset`                                   | Stop and **delete** all local data volumes                                              |
| `npm run db:migrate`                                     | Apply SQL migrations (`packages/core/drizzle`)                                          |
| `npm run db:generate`                                    | Generate a new migration after editing `packages/core/src/db/schema.ts`                 |
| `npm run db:seed`                                        | Create/refresh the demo user and demo tour (refuses in production)                      |
| `npm run samples:generate`                               | Write synthetic test panoramas into `./samples`                                         |
| `npm run samples:upload`                                 | Upload `./samples` to the demo tour through the real API                                |
| `npm test`                                               | Unit tests in every workspace                                                           |
| `npm run test:integration`                               | Integration tests against the Docker stack (`RUN_INTEGRATION=1`)                        |
| `npm run lint` / `format` / `format:check` / `typecheck` | Code quality                                                                            |
| `npm run build`                                          | Production builds: `apps/api/dist`, `apps/worker/dist`, `apps/web/dist` + `dist-server` |

## Testing

- **Unit** (`npm test`): storage drivers (contract suite), image validation, variant selection,
  yaw/pitch geometry, ownership rules, API client and share-snippet escaping.
- **Integration** (`npm run docker:up && npm run db:migrate && npm run test:integration`): the real
  API and an in-process worker against Postgres/Redis/MinIO — upload → S3 → queue → ready,
  invalid images, size-policy enforcement, ownership, retries with backoff, dead-letter queue,
  stuck-job recovery, public visibility and view counting.
- **CI** ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)): lint, format, typecheck, unit
  tests and build; a second job runs integration tests with service containers.

## Troubleshooting

| Symptom                                       | Fix                                                                                                                                                                                             |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run docker:up` fails / ports in use      | Stop local Postgres/Redis/MinIO or change the host ports in `docker-compose.yml` and the URLs in `.env`.                                                                                        |
| `db:migrate` cannot connect                   | Docker is not running or Postgres is still starting; rerun `npm run docker:up` (it waits for health checks).                                                                                    |
| Upload fails with a CORS error                | The bucket CORS rules were not applied: rerun `docker compose run --rm minio-init`. For other web origins add them to `docker/minio-cors.json` and set `MINIO_CORS_ORIGINS` before `docker:up`. |
| Scenes stay "Queued"                          | The worker is not running (`npm run dev` starts it) or `QUEUE_PREFIX`/`REDIS_URL` differ between API and worker.                                                                                |
| Scene "Failed" with a ratio/size message      | Portraits and strips wider than 24:1 are rejected. That is expected for `invalid-portrait.jpg`. Small landscapes are upscaled, not rejected.                                                |
| Images don't load in the viewer (403/expired) | Clock skew or a wrong `S3_PUBLIC_ENDPOINT`; browsers must reach the same host the URL was signed for.                                                                                           |
| Rooms uploaded in the wrong order             | File pickers often sort alphabetically. Prefix files `01-hall.jpg`, `02-kitchen.jpg`… or use **Re-link in order** after dragging the scene list.                                                |
| `samples:upload`: "Cannot reach the API"      | Start `npm run dev` first; run `npm run db:seed` if login fails.                                                                                                                                |
| "WebGL is not available"                      | Enable hardware acceleration in the browser.                                                                                                                                                    |
| `sharp` install errors                        | Use Node 20.12+ on a supported platform; delete `node_modules` and run `npm install` again.                                                                                                     |
| Start from scratch                            | `npm run docker:reset && npm run docker:up && npm run db:migrate && npm run db:seed`                                                                                                            |

## Deploying to production

Run **three independent services** from the same repo build (`npm ci && npm run build`):

| Service | Command                                                                                 | Scale                                                                                                                  |
| ------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| API     | `node apps/api/dist/server.js`                                                          | Stateless; scale horizontally behind a load balancer (health: `/api/healthz`, readiness: `/api/readyz`)                |
| Worker  | `node apps/worker/dist/main.js`                                                         | Scale by queue depth; each instance handles `WORKER_CONCURRENCY` jobs. CPU/RAM bound (8K images need ~1–2 GB per job). |
| Web     | `node apps/web/dist-server/serve.js` (or upload `apps/web/dist` to any static host/CDN) | Static; serve with the CSP headers from `server/serve.ts`                                                              |

Run `npm run db:migrate` (with production `DATABASE_URL`) as a release step before starting new
API/worker versions. Both API and worker shut down gracefully on `SIGTERM` (workers finish or
release in-flight jobs; the sweeper recovers anything interrupted).

**Routing.** Serve the SPA and API from one origin (`https://tours.example.com` → web, `/api/*` →
API) so cookies stay first-party. Set `WEB_ORIGIN` and `CORS_ORIGINS` to that origin,
`TRUST_PROXY` to the number of proxies, and `NODE_ENV=production`.

**Storage (AWS S3).**

1. Create a private bucket with _Block all public access_ on, default encryption, and a lifecycle
   rule aborting incomplete multipart uploads.
2. Add a CORS rule allowing `POST` (uploads) and `GET` from your web origin.
3. Set `S3_BUCKET`, `S3_REGION`, leave `S3_ENDPOINT` empty, `S3_FORCE_PATH_STYLE=false`, and leave
   the access keys empty so the SDK uses the instance/task role.
4. Give each service a **least-privilege** IAM role:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ApiObjects",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::YOUR_BUCKET/*"
    }
  ]
}
```

The API needs `PutObject` (to sign upload policies), `GetObject` (signed URLs, `HEAD` on
complete) and `DeleteObject`; the worker needs the same three actions. You can narrow the worker
to `originals/*` (get/delete) and `processed/*` (put/delete) and the API's `PutObject` to
`originals/*`. Neither needs `ListBucket` or any bucket-level permission.

**CDN (optional).** Put CloudFront in front of the bucket with Origin Access Control restricted to
`processed/*`, set `PUBLIC_BASE_URL=https://cdn.example.com`, and add that origin to
`CSP_MEDIA_ORIGINS`. Processed objects are immutable (`Cache-Control: public, max-age=31536000,
immutable`, unique keys per scene), so they cache forever. Originals are never exposed.

**Database and Redis.** Use managed Postgres 16 (RDS, Cloud SQL, Neon…) with TLS in
`DATABASE_URL`, and managed Redis 7 (ElastiCache, Upstash…) with `maxmemory-policy noeviction`
— BullMQ must not have keys evicted. With several API replicas, switch the in-memory rate-limit
store to Redis (see the extension point in `apps/api/src/middleware.ts`).

**Secrets** come only from the environment or your secret manager; none are committed and none
are logged (pino redacts cookies, auth headers, passwords and credentials).

## Roadmap

Out of scope for this version, with marked extension points in the code (`EXTENSION POINT`):

- **Payments / paid plans** — `packages/core/src/plans.ts` (a billing webhook updates
  `users.plan`; limits are already plan-driven).
- **Custom domains** — host-based tour lookup in `apps/api/src/routes/public.ts`.
- **AI enhancement** (denoise, auto-level, sky replacement) — pipeline stage in
  `apps/worker/src/image/pipeline.ts`.
- **Mobile app** — bearer-token sessions in `apps/api/src/middleware.ts`.
- **More storage drivers** (local disk, GCS, Azure) — `packages/core/src/storage/index.ts`.
- Multi-resolution tiled panoramas for >8K images, collaborative editing, and per-tour analytics
  exports.

## License

See [`LICENSE`](LICENSE) (placeholder — choose a license before publishing).
