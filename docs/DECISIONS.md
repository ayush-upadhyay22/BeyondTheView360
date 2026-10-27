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
