/**
 * Generates original synthetic equirectangular panoramas into ./samples (repo root):
 * three valid scenes (JPEG, PNG, WebP) and one deliberately invalid image (4:1 ratio)
 * to exercise the worker's validation. Fully offline and deterministic.
 *
 *   npm run samples:generate [-- --width 4096]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../../../samples');

const widthArg = process.argv.indexOf('--width');
const W = widthArg > 0 ? Number(process.argv[widthArg + 1]) : 4096;
if (!Number.isInteger(W) || W < 2048 || W > 16384) {
  console.error('--width must be an integer between 2048 and 16384');
  process.exit(1);
}
const H = W / 2;

/** Equirectangular mapping: yaw −180..180 (0 = image centre), pitch −90..90. */
const X = (yaw: number) => ((yaw + 180) / 360) * W;
const Y = (pitch: number) => ((90 - pitch) / 180) * H;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function label(yaw: number, pitch: number, text: string, size: number, fill: string) {
  return `<text x="${X(yaw)}" y="${Y(pitch)}" font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="${size}" fill="${fill}" text-anchor="middle" dominant-baseline="middle">${esc(text)}</text>`;
}

function compass(fill: string) {
  const s = H * 0.045;
  return [
    label(0, 6, 'N', s, '#ff6b5e'),
    label(90, 6, 'E', s, fill),
    label(180, 6, 'S', s, fill),
    label(-180, 6, 'S', s, fill),
    label(-90, 6, 'W', s, fill),
  ].join('');
}

/** Copies shapes shifted by ±W so anything crossing the seam wraps around. */
function wrap(content: string) {
  return `<g>${content}</g><g transform="translate(${W},0)">${content}</g><g transform="translate(${-W},0)">${content}</g>`;
}

function svg(defs: string, body: string) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs>${defs}</defs>${body}</svg>`,
  );
}

function courtyard() {
  const r = rng(7);
  let buildings = '';
  for (let yaw = -180; yaw < 180;) {
    const span = 14 + r() * 22;
    const top = 10 + r() * 22;
    const hue = 20 + r() * 30;
    const x = X(yaw);
    const w = (span / 360) * W;
    buildings += `<rect x="${x}" y="${Y(top)}" width="${w - 4}" height="${Y(-2) - Y(top)}" fill="hsl(${hue},28%,${55 + r() * 15}%)"/>`;
    for (let wy = top - 4; wy > 1; wy -= 5) {
      for (let wx = x + w * 0.1; wx < x + w * 0.85; wx += w * 0.18) {
        buildings += `<rect x="${wx}" y="${Y(wy)}" width="${w * 0.09}" height="${H * 0.014}" fill="hsl(205,40%,${30 + r() * 25}%)"/>`;
      }
    }
    yaw += span;
  }
  let tiles = '';
  for (let p = -4; p > -88; p -= 6 + (p / -90) * 10) {
    tiles += `<line x1="0" x2="${W}" y1="${Y(p)}" y2="${Y(p)}" stroke="#8c7a62" stroke-width="${H * 0.002}"/>`;
  }
  for (let yaw = -180; yaw < 180; yaw += 10) {
    tiles += `<line x1="${X(yaw)}" x2="${X(yaw)}" y1="${Y(-2)}" y2="${H}" stroke="#8c7a62" stroke-width="${H * 0.002}"/>`;
  }
  return svg(
    `<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
       <stop offset="0" stop-color="#1f5fa8"/><stop offset="1" stop-color="#cfe6f7"/></linearGradient>
     <radialGradient id="sun"><stop offset="0" stop-color="#fffbe6"/><stop offset="1" stop-color="#fffbe6" stop-opacity="0"/></radialGradient>`,
    `<rect width="${W}" height="${H / 2}" fill="url(#sky)"/>
     <rect y="${H / 2}" width="${W}" height="${H / 2}" fill="#b9a585"/>
     ${tiles}
     <circle cx="${X(-60)}" cy="${Y(45)}" r="${H * 0.06}" fill="url(#sun)"/>
     ${wrap(buildings)}
     ${compass('#ffffff')}
     ${label(0, -30, 'Sample · Courtyard', H * 0.035, '#5b4a35')}`,
  );
}

function gallery() {
  const r = rng(21);
  const palette = ['#e4572e', '#29335c', '#f3a712', '#a8c686', '#669bbc', '#c97b84'];
  let art = '';
  for (let yaw = -170; yaw < 180; yaw += 40) {
    const w = (22 / 360) * W;
    const top = 22 + r() * 6;
    const bottom = -4 - r() * 4;
    art += `<rect x="${X(yaw)}" y="${Y(top)}" width="${w}" height="${Y(bottom) - Y(top)}" fill="#2b2118"/>`;
    art += `<rect x="${X(yaw) + w * 0.06}" y="${Y(top) + w * 0.06}" width="${w * 0.88}" height="${Y(bottom) - Y(top) - w * 0.12}" fill="${palette[Math.floor(r() * palette.length)]}"/>`;
    art += `<circle cx="${X(yaw) + w * (0.3 + r() * 0.4)}" cy="${Y((top + bottom) / 2)}" r="${w * (0.12 + r() * 0.15)}" fill="${palette[Math.floor(r() * palette.length)]}"/>`;
  }
  let lights = '';
  for (let yaw = -180; yaw < 180; yaw += 30) {
    lights += `<ellipse cx="${X(yaw)}" cy="${Y(55)}" rx="${W * 0.012}" ry="${H * 0.008}" fill="#fff8dc"/>`;
  }
  let boards = '';
  for (let yaw = -180; yaw < 180; yaw += 6) {
    boards += `<line x1="${X(yaw)}" x2="${X(yaw)}" y1="${Y(-12)}" y2="${H}" stroke="#6b4f35" stroke-width="${H * 0.0015}"/>`;
  }
  return svg(
    `<linearGradient id="wall" x1="0" y1="0" x2="0" y2="1">
       <stop offset="0" stop-color="#f4efe6"/><stop offset="1" stop-color="#d9d0c1"/></linearGradient>`,
    `<rect width="${W}" height="${Y(40)}" fill="#ebe5da"/>
     <rect y="${Y(40)}" width="${W}" height="${Y(-12) - Y(40)}" fill="url(#wall)"/>
     <rect y="${Y(-12)}" width="${W}" height="${H - Y(-12)}" fill="#8a6a4a"/>
     ${boards}${lights}${wrap(art)}
     ${compass('#3a3a3a')}
     ${label(0, -40, 'Sample · Gallery', H * 0.035, '#f4efe6')}`,
  );
}

function rooftop() {
  const r = rng(99);
  let stars = '';
  for (let i = 0; i < 400; i++) {
    stars += `<circle cx="${r() * W}" cy="${r() * Y(25)}" r="${H * 0.0012 * (0.5 + r())}" fill="#fff" opacity="${0.3 + r() * 0.7}"/>`;
  }
  let skyline = '';
  for (let yaw = -180; yaw < 180;) {
    const span = 3 + r() * 7;
    const top = 2 + r() * 14;
    skyline += `<rect x="${X(yaw)}" y="${Y(top)}" width="${(span / 360) * W + 1}" height="${Y(0) - Y(top) + 1}" fill="#141029"/>`;
    for (let i = 0; i < 6; i++) {
      if (r() > 0.55) {
        skyline += `<rect x="${X(yaw + r() * span * 0.9)}" y="${Y(top * r())}" width="${W * 0.002}" height="${H * 0.004}" fill="#ffd27a"/>`;
      }
    }
    yaw += span;
  }
  return svg(
    `<linearGradient id="dusk" x1="0" y1="0" x2="0" y2="1">
       <stop offset="0" stop-color="#0b0b2b"/><stop offset="0.38" stop-color="#5a2d6e"/>
       <stop offset="0.5" stop-color="#ff9a5a"/></linearGradient>`,
    `<rect width="${W}" height="${H / 2}" fill="url(#dusk)"/>
     ${stars}${wrap(skyline)}
     <rect y="${Y(0)}" width="${W}" height="${H / 2}" fill="#2a2433"/>
     <rect y="${Y(-8)}" width="${W}" height="${H * 0.01}" fill="#4a4157"/>
     ${compass('#ffe3c4')}
     ${label(0, -30, 'Sample · Rooftop', H * 0.035, '#bfb3d6')}`,
  );
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const outputs: [string, () => Promise<Buffer>][] = [
    ['01-courtyard.jpg', () => sharp(courtyard()).jpeg({ quality: 88, mozjpeg: true }).toBuffer()],
    ['02-gallery.png', () => sharp(gallery()).png({ compressionLevel: 9 }).toBuffer()],
    ['03-rooftop.webp', () => sharp(rooftop()).webp({ quality: 88 }).toBuffer()],
    [
      'invalid-wide-strip.jpg',
      () =>
        sharp({
          create: { width: 4000, height: 1000, channels: 3, background: '#7a8a99' },
        })
          .composite([
            {
              input: Buffer.from(
                `<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="1000"><text x="2000" y="500" font-family="Helvetica, Arial, sans-serif" font-size="120" font-weight="700" fill="#fff" text-anchor="middle">4:1 — should be rejected</text></svg>`,
              ),
            },
          ])
          .jpeg()
          .toBuffer(),
    ],
  ];
  for (const [name, render] of outputs) {
    const file = resolve(outDir, name);
    const buf = await render();
    await writeFile(file, buf);
    console.info(`  ✓ ${name}  (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
  }
  console.info(`\nWrote ${outputs.length} images to ${outDir}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
