/**
 * Uploads every image in ./samples to the demo tour through the real public API — exactly the
 * flow the browser uses: login → presign → POST to storage → complete → poll until processed.
 * Afterwards the ready scenes are linked in a loop and the first one becomes the start scene.
 *
 *   npm run samples:upload            (API must be running: npm run dev)
 *   API_URL=https://… npm run samples:upload
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CSRF_HEADER,
  CSRF_HEADER_VALUE,
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

async function main() {
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
  const { tour: existing } = await api<{ tour: TourDTO }>('GET', `/tours/${summary.id}`);
  const existingNames = new Set(existing.scenes.map((s) => s.name));

  console.info(`Uploading ${files.length} file(s) to "${summary.title}" via ${API}\n`);
  const results: SceneDTO[] = [];
  for (const name of files) {
    const type = TYPES[extname(name).toLowerCase()]!;
    const sceneName = name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
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

  // Link ready scenes in a simple loop (A → B → C → A) when they have no links yet.
  const { tour } = await api<{ tour: TourDTO }>('GET', `/tours/${summary.id}`);
  const ready = tour.scenes
    .filter((s) => s.status === 'ready')
    .sort((a, b) => a.position - b.position);
  if (ready.length > 1) {
    for (const [i, scene] of ready.entries()) {
      if (scene.hotspots.some((h) => h.type === 'link')) continue;
      const next = ready[(i + 1) % ready.length]!;
      await api('POST', `/scenes/${scene.id}/hotspots`, {
        type: 'link',
        yaw: 0,
        pitch: -12,
        targetSceneId: next.id,
        title: `Go to ${next.name}`,
      });
      if (ready.length > 2) {
        const prev = ready[(i - 1 + ready.length) % ready.length]!;
        await api('POST', `/scenes/${scene.id}/hotspots`, {
          type: 'link',
          yaw: 180,
          pitch: -12,
          targetSceneId: prev.id,
          title: `Back to ${prev.name}`,
        });
      }
      await api('POST', `/scenes/${scene.id}/hotspots`, {
        type: 'info',
        yaw: 90,
        pitch: 5,
        title: `About ${scene.name}`,
        text: 'A synthetic sample panorama. Replace it with your own 2:1 photos.',
      });
    }
    console.info(`\nLinked ${ready.length} scenes.`);
  }
  if (ready[0] && !tour.startSceneId) {
    await api('PATCH', `/tours/${tour.id}`, { startSceneId: ready[0].id });
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
