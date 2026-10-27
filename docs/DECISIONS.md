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
