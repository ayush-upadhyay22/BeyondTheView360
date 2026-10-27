# BeyondTheView360 HTTP API

All endpoints live under `/api` and speak JSON. Types referenced below (`TourDTO`, `SceneDTO`, …)
are defined in [`packages/shared/src/dto.ts`](../packages/shared/src/dto.ts) and request bodies
are validated by the zod schemas in
[`packages/shared/src/schemas.ts`](../packages/shared/src/schemas.ts). Unknown body fields are
rejected.

## Conventions

| Topic          | Rule                                                                                                                                                        |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication | `btv_session` cookie (httpOnly, `SameSite=Lax`, `Secure` in production), set by signup/login. Send requests with `credentials: 'include'`.                  |
| CSRF           | Every non-GET request must send `x-btv-csrf: 1`. If an `Origin` header is present it must be the API's own origin or listed in `CORS_ORIGINS`/`WEB_ORIGIN`. |
| Ownership      | Resources of other users answer `404`, never `403`, so their existence is not revealed.                                                                     |
| Body size      | JSON bodies are limited by `JSON_BODY_LIMIT` (default `100kb`); images never pass through the API.                                                          |
| Rate limits    | Global per-IP limit on `/api`, plus stricter limits on auth, upload (`presign`/`complete`/`retry`) and view-ping endpoints. Exceeding them returns `429`.   |
| Media URLs     | Image URLs in responses are short-lived signed URLs (`SIGNED_URL_TTL_SECONDS`), or CDN URLs when `PUBLIC_BASE_URL` is set. Do not store them.               |

### Errors

Errors always have this shape:

```json
{ "error": { "code": "plan_limit", "message": "Your plan allows 3 tours.", "details": {} } }
```

| Status | `code`                                             | When                                                                                        |
| ------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 400    | `bad_request`, `invalid_json`                      | Malformed input; validation failures list `details.fields: [{ path, message }]`.            |
| 401    | `unauthorized`, `invalid_credentials`              | Not logged in; wrong email or password.                                                     |
| 402    | `plan_limit`                                       | Tour or scene quota of the plan reached.                                                    |
| 403    | `csrf`, `forbidden`                                | Missing CSRF header / disallowed origin.                                                    |
| 404    | `not_found`                                        | Missing, or owned by someone else.                                                          |
| 409    | `email_taken`, `upload_missing`, `duplicate_arrow` | Signup conflict; `complete` before the file arrived; a second next/back to the same target. |
| 413    | `file_too_large`, `payload_too_large`              | Image over the plan limit; JSON body too large.                                             |
| 429    | `rate_limited`                                     | Too many requests.                                                                          |
| 500    | `internal`                                         | Unexpected error (details are logged server-side, never returned).                          |

## Health

| Method & path      | Description                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------- |
| `GET /api/healthz` | Liveness: `{ ok: true }` while the process runs.                                            |
| `GET /api/readyz`  | Readiness: checks Postgres, Redis and storage. `503` with `{ failed: [...] }` if any fails. |

## Auth

| Method & path           | Body                                        | Response                                                  |
| ----------------------- | ------------------------------------------- | --------------------------------------------------------- |
| `POST /api/auth/signup` | `{ email, password }` (password ≥ 10 chars) | `201 { user: UserDTO }` + session cookie                  |
| `POST /api/auth/login`  | `{ email, password }`                       | `200 { user: UserDTO }` + session cookie                  |
| `POST /api/auth/logout` | —                                           | `204`, session deleted, cookie cleared                    |
| `GET /api/auth/me`      | —                                           | `200 { user: UserDTO }` (includes plan `limits`) or `401` |

## Tours (owner only)

| Method & path                             | Body                                                                 | Response                                                         |
| ----------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `GET /api/tours`                          | —                                                                    | `{ tours: TourSummaryDTO[] }`, newest first                      |
| `POST /api/tours`                         | `{ title }`                                                          | `201 { tour: TourDTO }` · `402` at the plan's tour limit         |
| `GET /api/tours/:id`                      | —                                                                    | `{ tour: TourDTO }` with all scenes (any status) and hotspots    |
| `PATCH /api/tours/:id`                    | any of `{ title, description, visibility, startSceneId, startView }` | `{ tour: TourDTO }`                                              |
| `DELETE /api/tours/:id`                   | —                                                                    | `204`; scenes, hotspots, stats and stored images are removed     |
| `PUT /api/tours/:id/scenes/order`         | `{ sceneIds: uuid[] }` — every scene exactly once                    | `{ tour: TourDTO }`                                              |
| `POST /api/tours/:id/link-in-order`       | `{ mode?: "missing" \| "rebuild" }` (default `missing`)              | `{ result: { added, removed }, tour }`                           |
| `POST /api/tours/:id/auto-link-nearby`    | `{ neighbors?: 1–4 }` (default 2) — needs floor-plan pins            | `{ result: { added, removed: 0 }, tour }`                        |
| `POST /api/tours/:id/floor-plan/presign`  | `{ contentType: "image/webp", size }`                                | `201 FloorPlanPresignResponse`                                   |
| `POST /api/tours/:id/floor-plan/complete` | `{ key, width, height }`                                             | `{ tour }` · `409 upload_missing`                                |
| `DELETE /api/tours/:id/floor-plan`        | —                                                                    | `{ tour }`                                                       |
| `GET /api/tours/:id/stats`                | —                                                                    | `TourStatsDTO`: `{ total, daily: [{ day, count }] }` for 30 days |

`visibility` is `private` (owner only), `unlisted` (anyone with the link) or `public`.
`startView` is `{ yaw, pitch, fov }` in degrees: yaw −180…180 (0 = image centre, positive = right),
pitch −90…90 (positive = up), fov 30…100.

## Scenes and uploads (owner only)

Uploading is a three-step flow; image bytes go **directly from the browser to S3/MinIO**:

```text
1. POST /api/scenes/presign        → scene (status "pending") + presigned POST { url, fields }
2. POST <upload.url>  (multipart)  → fields…, then file  — straight to storage
3. POST /api/scenes/:id/complete   → verifies the object, status "queued", job enqueued
   … worker: queued → processing (progress 0–100) → ready | failed
```

| Method & path                   | Body                                                                                                           | Response                                                            |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `POST /api/scenes/presign`      | `{ tourId, filename, contentType, size }` — `contentType` ∈ `image/jpeg`, `image/png`, `image/webp`            | `201 PresignUploadResponse` · `413` too large · `402` scene limit   |
| `POST /api/scenes/:id/complete` | —                                                                                                              | `202 { scene }` (idempotent) · `409 upload_missing`                 |
| `POST /api/scenes/:id/retry`    | —                                                                                                              | `202 { scene }` for `failed` scenes                                 |
| `GET /api/scenes/:id`           | —                                                                                                              | `{ scene: SceneDTO }` — poll this for `status`, `progress`, `error` |
| `PATCH /api/scenes/:id`         | any of `{ name, startView, northOffset, mapX, mapY }` (`mapX`/`mapY` 0…1, set together)                        | `{ scene }`                                                         |
| `DELETE /api/scenes/:id`        | query `?relink=1` reconnects the rooms before and after                                                        | `204`; hotspots pointing to it are removed                          |
| `POST /api/scenes/:id/hotspots` | `{ kind: "next"\|"back"\|"link"\|"info", yaw, pitch, … }` — a missing `kind` (or legacy `type`) means `"link"` | `201 { hotspot }` · `409 duplicate_arrow` for a second next/back    |

The presigned POST policy pins the object key, the exact `Content-Type` and a
`content-length-range` of 1 byte … the plan's max upload size, so storage itself rejects anything
else. Uploading the form (step 2):

```js
const form = new FormData();
for (const [k, v] of Object.entries(upload.fields)) form.append(k, v);
form.append('file', file); // must be last
await fetch(upload.url, { method: 'POST', body: form });
```

The worker validates the real bytes (magic number, 2:1 ±5 % aspect ratio, ≥ 2048 px wide), strips
all metadata including GPS, and writes WebP variants (1024/2048/4096/8192, never upscaled), a
320 px JPEG thumbnail and a blurred placeholder. Invalid images end as `failed` with a readable
`error`; transient failures are retried 3 times with exponential backoff first.

## Hotspots (owner only)

| Method & path              | Body                                                          | Response      |
| -------------------------- | ------------------------------------------------------------- | ------------- |
| `PATCH /api/hotspots/:id`  | any of `{ yaw, pitch, title, text, imageUrl, targetSceneId }` | `{ hotspot }` |
| `DELETE /api/hotspots/:id` | —                                                             | `204`         |

`targetSceneId` must be another scene of the same tour. `imageUrl` must be `http(s)`. All text
is stored verbatim and rendered as text (never as HTML) by the web app. A scene may have at most
50 hotspots. `kind` is `next` or `back` (walk-through floor arrows), `link` (labelled jump) or
`info` (title, text, optional image). Uploading a scene automatically adds next/back arrows to
the previous usable scene of the tour, in one transaction. `link-in-order` with `missing` only
adds absent arrows; `rebuild` also deletes next/back arrows that no longer match the order.
Custom `link` and `info` hotspots are never touched.

Angles are **degrees**: yaw −180…180 (0 = image centre, positive = right), pitch −90…90
(positive = up). Auto-created next/back arrows sit at yaw 0 / 180 and pitch ≈ −17° (−0.3 rad).

## Public (no login needed)

| Method & path                           | Body | Response                                                                                                                                                   |
| --------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/public/tours/:shareId`        | —    | `{ tour: PublicTourDTO }` — only `ready` scenes and links between them. Private tours: `404` unless you are the owner. `Cache-Control: private, no-store`. |
| `POST /api/public/tours/:shareId/views` | —    | `204`. Counts a view (the web app sends one per browser session). Nothing identifying is stored; the owner's own views are ignored. Needs the CSRF header. |

`shareId` is the short random id in `/t/:shareId` and `/embed/:shareId` links.

## Example session (curl)

```bash
API=http://localhost:4000/api
H='x-btv-csrf: 1'
curl -s -c jar -H "$H" -H 'content-type: application/json' \
  -d '{"email":"demo@example.com","password":"beyond-the-view-demo"}' $API/auth/login
curl -s -b jar $API/tours
```
