/**
 * Uploads every image in ./samples to the demo tour through the real public API — exactly the
 * flow the browser uses: login → presign → POST to storage → complete → poll until processed.
 * Each presign auto-links the new room to the previous one (next/back arrows). The first
 * ready scene becomes the tour start. Already-uploaded scene names are skipped.
 *
 *   npm run samples:upload                (API must be running: npm run dev)
 *   npm run samples:upload -- --rebuild   (delete existing demo scenes first)
 *   API_URL=https://… npm run samples:upload
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CSRF_HEADER,
  CSRF_HEADER_VALUE,
  FLOOR_PLAN_CONTENT_TYPE,
  type FloorPlanPresignResponse,
  type PresignUploadResponse,
  type SceneDTO,
  type TourDTO,
  type TourSummaryDTO,
} from '@btv/shared';
import { DEMO } from './demo.js';

const here = dirname(fileURLToPath(import.meta.url));
const samplesDir = resolve(here, '../../../samples');
const API = (process.env.API_URL ?? 'http://localhost:4000/api').replace(/\/$/, '');
const WEB = (process.env.WEB_URL ?? 'http://localhost:5173').replace(/\/$/, '');

const TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

let cookie = '';

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        ...(body !== undefined && { 'content-type': 'application/json' }),
        ...(method !== 'GET' && { [CSRF_HEADER]: CSRF_HEADER_VALUE }),
        ...(cookie && { cookie }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error(`Cannot reach the API at ${API}. Is "npm run dev" running?`);
  }
  const setCookie = res.headers.getSetCookie?.() ?? [];
  if (setCookie.length) cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as T & { error?: { message: string } };
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${data?.error?.message ?? ''}`);
  return data;
}

async function uploadToStorage(
  upload: PresignUploadResponse['upload'],
  file: Buffer,
  type: string,
) {
  const form = new FormData();
  for (const [k, v] of Object.entries(upload.fields)) form.append(k, v);
  form.append('file', new Blob([new Uint8Array(file)], { type }));
  const res = await fetch(upload.url, { method: 'POST', body: form });
  if (!res.ok) {
    throw new Error(
      `storage rejected the upload (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }
}

async function waitForScene(id: string, timeoutMs = 180_000): Promise<SceneDTO> {
  const started = Date.now();
  let last = '';
  for (;;) {
    const { scene } = await api<{ scene: SceneDTO }>('GET', `/scenes/${id}`);
    if (scene.status === 'ready' || scene.status === 'failed') return scene;
    const line = `${scene.status}${scene.status === 'processing' ? ` ${Math.round(scene.progress)}%` : ''}`;
    if (line !== last) process.stdout.write(`    … ${line}\n`);
    last = line;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out (is the worker running? "npm run dev" starts it)`);
    }
    await new Promise((r) => setTimeout(r, 800));
  }
}

function sceneNameFromFile(name: string) {
  return name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
}

function isSceneSample(name: string) {
  const base = name.toLowerCase();
  return !base.startsWith('floor-plan') && !base.startsWith('invalid-');
}

async function main() {
  const replace = process.argv.includes('--rebuild') || process.argv.includes('--replace');
  const files = (await readdir(samplesDir).catch(() => []))
    .filter((f) => TYPES[extname(f).toLowerCase()])
    .sort();
  if (files.length === 0) {
    console.error(`No images in ${samplesDir}. Run "npm run samples:generate" first.`);
    process.exit(1);
  }

  await api('POST', '/auth/login', { email: DEMO.email, password: DEMO.password }).catch(
    (err: Error) => {
      throw new Error(`${err.message}\nDid you run "npm run db:seed"?`);
    },
  );
  const { tours } = await api<{ tours: TourSummaryDTO[] }>('GET', '/tours');
  const summary = tours.find((t) => t.shareId === DEMO.shareId) ?? tours[0];
  if (!summary) throw new Error('Demo tour not found. Run "npm run db:seed" first.');
  let { tour: existing } = await api<{ tour: TourDTO }>('GET', `/tours/${summary.id}`);

  if (replace && existing.scenes.length) {
    await api('PATCH', `/tours/${existing.id}`, { startSceneId: null });
    console.info(`Replacing ${existing.scenes.length} existing scene(s)\n`);
    for (const scene of [...existing.scenes].sort((a, b) => b.position - a.position)) {
      await api('DELETE', `/scenes/${scene.id}?relink=1`);
    }
    ({ tour: existing } = await api<{ tour: TourDTO }>('GET', `/tours/${existing.id}`));
  }

  const existingNames = new Set(existing.scenes.map((s) => s.name));
  const sceneFiles = files.filter(isSceneSample);
  const rejectFiles = files.filter((f) => f.toLowerCase().startsWith('invalid-'));

  await api('PATCH', `/tours/${existing.id}`, {
    title: DEMO.tourTitle,
    description: DEMO.tourDescription,
  });

  console.info(`Uploading ${sceneFiles.length + rejectFiles.length} file(s) to "${DEMO.tourTitle}" via ${API}\n`);
  const results: SceneDTO[] = [];
  for (const name of [...sceneFiles, ...rejectFiles]) {
    const type = TYPES[extname(name).toLowerCase()]!;
    const sceneName = sceneNameFromFile(name);
    if (existingNames.has(sceneName)) {
      console.info(`• ${name}: already in the tour, skipping`);
      continue;
    }
    const data = await readFile(resolve(samplesDir, name));
    console.info(`• ${name} (${(data.length / 1024 / 1024).toFixed(1)} MB)`);
    try {
      const { scene, upload } = await api<PresignUploadResponse>('POST', '/scenes/presign', {
        tourId: summary.id,
        filename: name,
        contentType: type,
        size: data.length,
      });
      await uploadToStorage(upload, data, type);
      await api('POST', `/scenes/${scene.id}/complete`);
      const done = await waitForScene(scene.id);
      if (done.status === 'ready') {
        console.info(`    ✓ ready (${done.width}×${done.height}, ${done.variants.length} sizes)`);
      } else {
        console.info(`    ✗ rejected: ${done.error}`);
      }
      results.push(done);
    } catch (err) {
      console.info(`    ✗ ${(err as Error).message}`);
    }
  }

  let { tour } = await api<{ tour: TourDTO }>('GET', `/tours/${summary.id}`);
  const ready = tour.scenes
    .filter((s) => s.status === 'ready')
    .sort((a, b) => a.position - b.position);
  if (ready.length > 1) {
    const { result } = await api<{ result: { added: number; removed: number } }>(
      'POST',
      `/tours/${tour.id}/link-in-order`,
      { mode: 'rebuild' },
    );
    console.info(
      `\nWalk-through: ${ready.length} rooms in order${
        result.added ? ` (${result.added} missing arrow${result.added === 1 ? '' : 's'} added)` : ''
      }.`,
    );
  }

  const planFile = files.find((f) => f.toLowerCase().startsWith('floor-plan.') && f.endsWith('.webp'));
  const pinFile = resolve(samplesDir, 'floor-plan.json');
  if (planFile) {
    const data = await readFile(resolve(samplesDir, planFile));
    const meta = JSON.parse(await readFile(pinFile, 'utf8').catch(() => '{}')) as {
      width?: number;
      height?: number;
      pins?: Record<string, { x: number; y: number }>;
    };
    console.info(`\n• ${planFile} (house plan)`);
    const { key, upload } = await api<FloorPlanPresignResponse>(
      'POST',
      `/tours/${tour.id}/floor-plan/presign`,
      { contentType: FLOOR_PLAN_CONTENT_TYPE, size: data.length },
    );
    await uploadToStorage(upload, data, FLOOR_PLAN_CONTENT_TYPE);
    ({ tour } = await api<{ tour: TourDTO }>('POST', `/tours/${tour.id}/floor-plan/complete`, {
      key,
      width: meta.width ?? 1600,
      height: meta.height ?? 1100,
    }));
    console.info('    ✓ floor plan attached');
    for (const scene of tour.scenes) {
      const pin = meta.pins?.[scene.name];
      if (!pin) continue;
      await api('PATCH', `/scenes/${scene.id}`, { mapX: pin.x, mapY: pin.y, northOffset: 0 });
      console.info(`    ✓ pinned ${scene.name}`);
    }
    if (tour.scenes.filter((s) => s.status === 'ready').length >= 2) {
      const { result } = await api<{ result: { added: number } }>(
        'POST',
        `/tours/${tour.id}/auto-link-nearby`,
        { neighbors: 2 },
      );
      console.info(
        `    ✓ auto-linked nearby rooms${result.added ? ` (+${result.added} arrows)` : ''}`,
      );
    }
  }

  ({ tour } = await api<{ tour: TourDTO }>('GET', `/tours/${tour.id}`));
  const start = tour.scenes.find((s) => s.name === '01 hall') ?? ready[0];
  if (start) {
    await api('PATCH', `/tours/${tour.id}`, { startSceneId: start.id });
  }

  const failed = results.filter((r) => r.status === 'failed').length;
  console.info(
    `\nDone: ${ready.length} ready scene(s)${failed ? `, ${failed} rejected (expected for invalid samples)` : ''}.`,
  );
  console.info(`Open ${WEB}/t/${tour.shareId}  ·  edit at ${WEB}/app/tours/${tour.id}`);
}

main().catch((err: unknown) => {
  console.error(`\n✗ ${(err as Error).message}`);
  process.exit(1);
});
