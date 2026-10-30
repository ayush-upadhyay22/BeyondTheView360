/**
 * Generates original equirectangular rooms into ./samples (repo root):
 * five walk-through interiors (hall → kitchen → living → bedroom → garden), a house
 * floor plan with pin coordinates, and one invalid portrait for the reject path.
 * Fully offline and deterministic.
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
const span = (deg: number) => (deg / 360) * W;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function label(yaw: number, pitch: number, text: string, size: number, fill: string) {
  return `<text x="${X(yaw)}" y="${Y(pitch)}" font-family="Georgia, 'Times New Roman', serif" font-weight="600" font-size="${size}" fill="${fill}" text-anchor="middle" dominant-baseline="middle">${esc(text)}</text>`;
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

function skyCeiling(id: string, top: string, mid: string) {
  return `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${mid}"/></linearGradient>`;
}

function wallLight(id: string, top: string, bottom: string) {
  return `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient>`;
}

function floorShade(id: string, near: string, far: string) {
  return `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${near}"/><stop offset="1" stop-color="${far}"/></linearGradient>`;
}

function glow(id: string, color: string) {
  return `<radialGradient id="${id}" cx="50%" cy="50%" r="50%">
    <stop offset="0" stop-color="${color}" stop-opacity="0.85"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient>`;
}

function wallStrips(seed: number, fromPitch: number, toPitch: number, hue: number, sat: number, base: number) {
  const r = rng(seed);
  let out = '';
  for (let yaw = -180; yaw < 180; yaw += 3) {
    const light = base + (r() - 0.45) * 8;
    out += `<rect x="${X(yaw)}" y="${Y(fromPitch)}" width="${span(3.2)}" height="${Y(toPitch) - Y(fromPitch)}" fill="hsl(${hue},${sat}%,${light}%)"/>`;
  }
  return out;
}

function planks(seed: number, floorPitch: number, hue: number, sat: number, light: number) {
  const r = rng(seed);
  let out = '';
  for (let yaw = -180; yaw < 180; yaw += 5) {
    const l = light + (r() - 0.5) * 7;
    out += `<line x1="${X(yaw)}" x2="${X(yaw)}" y1="${Y(floorPitch)}" y2="${H}" stroke="hsl(${hue},${sat}%,${l}%)" stroke-width="${H * 0.002}"/>`;
  }
  for (let p = floorPitch; p > -88; p -= 7 + (floorPitch - p) * 0.08) {
    out += `<line x1="0" x2="${W}" y1="${Y(p)}" y2="${Y(p)}" stroke="rgba(0,0,0,0.08)" stroke-width="${H * 0.001}"/>`;
  }
  return out;
}

function windowSky(id: string, top: string, bot: string) {
  return `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bot}"/></linearGradient>`;
}

function windowBay(yaw: number, width: number, skyId: string, sash = '#f7f2ea') {
  const x = X(yaw - width / 2);
  const w = span(width);
  return `<rect x="${x - 6}" y="${Y(34)}" width="${w + 12}" height="${Y(-4) - Y(34)}" fill="#3a2d22"/>
    <rect x="${x}" y="${Y(32)}" width="${w}" height="${Y(-2) - Y(32)}" fill="url(#${skyId})"/>
    <rect x="${x}" y="${Y(32)}" width="${w}" height="${Y(-2) - Y(32)}" fill="none" stroke="${sash}" stroke-width="${H * 0.006}"/>
    <line x1="${x + w / 2}" x2="${x + w / 2}" y1="${Y(32)}" y2="${Y(-2)}" stroke="${sash}" stroke-width="${H * 0.004}"/>
    <line x1="${x}" x2="${x + w}" y1="${Y(15)}" y2="${Y(15)}" stroke="${sash}" stroke-width="${H * 0.004}"/>
    <ellipse cx="${x + w / 2}" cy="${Y(-6)}" rx="${w * 0.45}" ry="${H * 0.03}" fill="#fff6d4" opacity="0.18"/>`;
}

function door(yaw: number, wood: string, plaque: string) {
  const x = X(yaw - 11);
  const w = span(22);
  return `<rect x="${x - 8}" y="${Y(28)}" width="${w + 16}" height="${Y(-8) - Y(28)}" fill="#2b2118"/>
    <rect x="${x}" y="${Y(26)}" width="${w}" height="${Y(-8) - Y(26)}" fill="${wood}"/>
    <rect x="${x + w * 0.12}" y="${Y(20)}" width="${w * 0.32}" height="${Y(4) - Y(20)}" fill="${wood}" stroke="#2b2118" stroke-width="2"/>
    <rect x="${x + w * 0.56}" y="${Y(20)}" width="${w * 0.32}" height="${Y(4) - Y(20)}" fill="${wood}" stroke="#2b2118" stroke-width="2"/>
    <rect x="${x + w * 0.12}" y="${Y(0)}" width="${w * 0.32}" height="${Y(-8) - Y(0)}" fill="${wood}" stroke="#2b2118" stroke-width="2"/>
    <rect x="${x + w * 0.56}" y="${Y(0)}" width="${w * 0.32}" height="${Y(-8) - Y(0)}" fill="${wood}" stroke="#2b2118" stroke-width="2"/>
    <circle cx="${x + w * 0.82}" cy="${Y(2)}" r="${H * 0.008}" fill="#c9a227"/>
    ${label(yaw, 30, plaque, H * 0.016, '#f4ead8')}`;
}

function pendant(yaw: number, drop = 52) {
  return `<line x1="${X(yaw)}" x2="${X(yaw)}" y1="${Y(88)}" y2="${Y(drop)}" stroke="#cfc4ae" stroke-width="${H * 0.002}"/>
    <ellipse cx="${X(yaw)}" cy="${Y(drop)}" rx="${W * 0.018}" ry="${H * 0.012}" fill="#f3e6c2"/>
    <ellipse cx="${X(yaw)}" cy="${Y(drop - 14)}" rx="${W * 0.07}" ry="${H * 0.045}" fill="url(#lampGlow)"/>`;
}

function northMark() {
  return label(0, 8, 'N', H * 0.028, '#ef4444');
}

function hall() {
  const furniture = `
    <ellipse cx="${X(-90)}" cy="${Y(-8)}" rx="${span(28)}" ry="${H * 0.035}" fill="#3d2a1c" opacity="0.35"/>
    <rect x="${X(-104)}" y="${Y(-2)}" width="${span(28)}" height="${H * 0.055}" fill="#6b4423" rx="6"/>
    <rect x="${X(-100)}" y="${Y(16)}" width="${span(20)}" height="${H * 0.09}" fill="#d9cbb8" stroke="#8a7358"/>
    <ellipse cx="${X(90)}" cy="${Y(-10)}" rx="${span(16)}" ry="${H * 0.02}" fill="#2a4a28" opacity="0.55"/>
    <ellipse cx="${X(90)}" cy="${Y(4)}" rx="${span(10)}" ry="${H * 0.05}" fill="#3f6b3a"/>
    <ellipse cx="${X(90)}" cy="${Y(14)}" rx="${span(7)}" ry="${H * 0.035}" fill="#2f5530"/>`;
  return svg(
    `${skyCeiling('hCeil', '#f7f0e4', '#eadcc4')}
     ${wallLight('hWall', '#f3e6d0', '#d9c4a4')}
     ${floorShade('hFloor', '#8a5a32', '#4e3118')}
     ${windowSky('dayWin', '#7ea7d4', '#d7e8f7')}
     ${glow('lampGlow', '#ffe7a8')}`,
    `<rect width="${W}" height="${Y(40)}" fill="url(#hCeil)"/>
     <rect y="${Y(40)}" width="${W}" height="${Y(-8) - Y(40)}" fill="url(#hWall)"/>
     ${wallStrips(11, 40, -8, 36, 28, 84)}
     <rect y="${Y(-8)}" width="${W}" height="${H - Y(-8)}" fill="url(#hFloor)"/>
     ${planks(3, -8, 28, 38, 32)}
     ${wrap(windowBay(-50, 36, 'dayWin'))}
     ${wrap(door(0, '#7a4a24', 'Kitchen'))}
     ${wrap(door(180, '#5c3a1c', 'Garden'))}
     ${wrap(door(90, '#6b4423', 'Living'))}
     ${wrap(door(-90, '#6b4423', 'Bedroom'))}
     ${wrap(furniture)}
     ${pendant(0)}${pendant(180)}
     ${northMark()}`,
  );
}

function kitchen() {
  let cabinets = '';
  for (let yaw = -150; yaw <= 150; yaw += 24) {
    if (Math.abs(yaw) < 18 || Math.abs(yaw - 90) < 16) continue;
    cabinets += `<rect x="${X(yaw)}" y="${Y(10)}" width="${span(20)}" height="${Y(-8) - Y(10)}" fill="#f4f0e8" stroke="#b7a48c"/>
      <rect x="${X(yaw)}" y="${Y(42)}" width="${span(20)}" height="${Y(16) - Y(42)}" fill="#efe6d6" stroke="#b7a48c"/>
      <circle cx="${X(yaw + 16)}" cy="${Y(2)}" r="${H * 0.005}" fill="#c9a227"/>`;
  }
  const island = `
    <ellipse cx="${X(0)}" cy="${Y(-10)}" rx="${span(38)}" ry="${H * 0.04}" fill="#2a241c" opacity="0.28"/>
    <rect x="${X(-32)}" y="${Y(-6)}" width="${span(64)}" height="${H * 0.07}" rx="10" fill="#6e4a2e"/>
    <rect x="${X(-30)}" y="${Y(-2)}" width="${span(60)}" height="${H * 0.018}" fill="#d8c4a4"/>`;
  return svg(
    `${skyCeiling('kCeil', '#f5f8fb', '#e4eef3')}
     ${wallLight('kWall', '#eef4f6', '#d5e0e5')}
     ${floorShade('kFloor', '#e8eef1', '#c5d0d6')}
     ${windowSky('dayWin', '#87b5e0', '#f0f6fb')}
     ${glow('lampGlow', '#fff4c8')}`,
    `<rect width="${W}" height="${Y(42)}" fill="url(#kCeil)"/>
     <rect y="${Y(42)}" width="${W}" height="${Y(-8) - Y(42)}" fill="url(#kWall)"/>
     ${wallStrips(19, 42, -8, 200, 10, 90)}
     <rect y="${Y(-8)}" width="${W}" height="${H - Y(-8)}" fill="url(#kFloor)"/>
     ${planks(8, -8, 200, 6, 82)}
     ${wrap(windowBay(90, 40, 'dayWin'))}
     ${wrap(cabinets)}
     ${wrap(island)}
     ${wrap(door(180, '#7a4a24', 'Hall'))}
     ${pendant(-20)}${pendant(20)}
     ${northMark()}`,
  );
}

function living() {
  const r = rng(21);
  const palette = ['#c45c3e', '#2d3a5a', '#d4a017', '#6f8f5a', '#4d7ea8', '#b56b74'];
  let art = '';
  for (const yaw of [-140, -40, 50, 140]) {
    const w = span(20);
    art += `<rect x="${X(yaw)}" y="${Y(24)}" width="${w}" height="${Y(-2) - Y(24)}" fill="#2b2118"/>
      <rect x="${X(yaw) + w * 0.06}" y="${Y(22)}" width="${w * 0.88}" height="${Y(0) - Y(22)}" fill="${palette[Math.floor(r() * palette.length)]}"/>`;
  }
  const sofa = `
    <ellipse cx="${X(0)}" cy="${Y(-10)}" rx="${span(50)}" ry="${H * 0.045}" fill="#2a241c" opacity="0.25"/>
    <rect x="${X(-42)}" y="${Y(-8)}" width="${span(84)}" height="${H * 0.07}" rx="16" fill="#6b4a36"/>
    <rect x="${X(-38)}" y="${Y(0)}" width="${span(76)}" height="${H * 0.035}" rx="10" fill="#8a6248"/>
    <rect x="${X(-48)}" y="${Y(-4)}" width="${span(10)}" height="${H * 0.055}" rx="6" fill="#5c3d2c"/>
    <rect x="${X(38)}" y="${Y(-4)}" width="${span(10)}" height="${H * 0.055}" rx="6" fill="#5c3d2c"/>`;
  return svg(
    `${skyCeiling('lCeil', '#f6efe4', '#e6d7c2')}
     ${wallLight('lWall', '#f0e6d6', '#d8c8b0')}
     ${floorShade('lFloor', '#9a6a40', '#5a3a20')}
     ${windowSky('dayWin', '#6ea0d4', '#dceaf8')}
     ${glow('lampGlow', '#ffe2a0')}`,
    `<rect width="${W}" height="${Y(40)}" fill="url(#lCeil)"/>
     <rect y="${Y(40)}" width="${W}" height="${Y(-10) - Y(40)}" fill="url(#lWall)"/>
     ${wallStrips(27, 40, -10, 34, 22, 82)}
     <rect y="${Y(-10)}" width="${W}" height="${H - Y(-10)}" fill="url(#lFloor)"/>
     ${planks(14, -10, 28, 40, 30)}
     ${wrap(windowBay(-90, 44, 'dayWin'))}
     ${wrap(art)}${wrap(sofa)}
     ${wrap(door(180, '#6b4423', 'Hall'))}
     ${pendant(0)}${pendant(40)}${pendant(-40)}
     ${northMark()}`,
  );
}

function bedroom() {
  let drapes = '';
  for (let yaw = 64; yaw < 116; yaw += 3) {
    const l = 46 + ((yaw * 3) % 10);
    drapes += `<rect x="${X(yaw)}" y="${Y(36)}" width="${span(3)}" height="${Y(-4) - Y(36)}" fill="hsl(258,22%,${l}%)"/>`;
  }
  const bed = `
    <ellipse cx="${X(0)}" cy="${Y(-8)}" rx="${span(48)}" ry="${H * 0.05}" fill="#1a1220" opacity="0.35"/>
    <rect x="${X(-40)}" y="${Y(-6)}" width="${span(80)}" height="${H * 0.085}" rx="14" fill="#4a3558"/>
    <rect x="${X(-36)}" y="${Y(-2)}" width="${span(72)}" height="${H * 0.04}" rx="10" fill="#e8dcec"/>
    <rect x="${X(-38)}" y="${Y(6)}" width="${span(20)}" height="${H * 0.03}" rx="8" fill="#f4eef6"/>
    <rect x="${X(18)}" y="${Y(6)}" width="${span(20)}" height="${H * 0.03}" rx="8" fill="#f4eef6"/>`;
  return svg(
    `${skyCeiling('bCeil', '#1a2038', '#3d3558')}
     ${wallLight('bWall', '#d8cce4', '#b9a8c8')}
     ${floorShade('bFloor', '#6a5360', '#3a2a34')}
     ${windowSky('duskWin', '#1b2748', '#6b5b8a')}
     ${glow('lampGlow', '#f0c878')}`,
    `<rect width="${W}" height="${Y(36)}" fill="url(#bCeil)"/>
     <rect y="${Y(36)}" width="${W}" height="${Y(-8) - Y(36)}" fill="url(#bWall)"/>
     ${wallStrips(33, 36, -8, 270, 14, 78)}
     <rect y="${Y(-8)}" width="${W}" height="${H - Y(-8)}" fill="url(#bFloor)"/>
     ${planks(17, -8, 320, 12, 28)}
     ${wrap(windowBay(90, 42, 'duskWin'))}
     ${wrap(drapes)}${wrap(bed)}
     ${wrap(door(180, '#4a3550', 'Hall'))}
     ${pendant(-28, 48)}${pendant(28, 48)}
     ${northMark()}`,
  );
}

function garden() {
  const r = rng(7);
  let trees = '';
  for (let yaw = -170; yaw < 170; yaw += 22 + r() * 10) {
    const x = X(yaw);
    trees += `<rect x="${x - span(2)}" y="${Y(8)}" width="${span(4)}" height="${Y(-2) - Y(8)}" fill="#5a3a22"/>
      <ellipse cx="${x}" cy="${Y(16 + r() * 8)}" rx="${span(9 + r() * 6)}" ry="${H * 0.07}" fill="hsl(${110 + r() * 30},40%,${28 + r() * 16}%)"/>
      <ellipse cx="${x + span(4)}" cy="${Y(12)}" rx="${span(7)}" ry="${H * 0.05}" fill="hsl(${100 + r() * 20},38%,${24 + r() * 12}%)"/>`;
  }
  let facade = '';
  for (let yaw = 150; yaw <= 210; yaw += 12) {
    facade += `<rect x="${X(yaw)}" y="${Y(28)}" width="${span(11)}" height="${Y(-2) - Y(28)}" fill="#c4b49a" stroke="#8a7a62"/>
      <rect x="${X(yaw + 2)}" y="${Y(18)}" width="${span(6)}" height="${Y(8) - Y(18)}" fill="#6ea0d4"/>`;
  }
  return svg(
    `${skyCeiling('gSky', '#1f5fa8', '#cfe6f7')}
     ${floorShade('gPatio', '#c4b08a', '#8a7354')}
     ${glow('lampGlow', '#fff6c4')}
     <radialGradient id="sun"><stop offset="0" stop-color="#fff7c8"/><stop offset="1" stop-color="#fff7c8" stop-opacity="0"/></radialGradient>`,
    `<rect width="${W}" height="${Y(2)}" fill="url(#gSky)"/>
     <rect y="${Y(2)}" width="${W}" height="${H - Y(2)}" fill="#7a9a4a"/>
     <rect y="${Y(-2)}" width="${W}" height="${Y(-28) - Y(-2)}" fill="url(#gPatio)"/>
     ${planks(9, -2, 40, 18, 48)}
     <circle cx="${X(-55)}" cy="${Y(42)}" r="${H * 0.09}" fill="url(#sun)"/>
     ${wrap(trees)}
     ${wrap(facade)}
     ${wrap(door(180, '#7a4a24', 'Hall'))}
     <ellipse cx="${X(20)}" cy="${Y(-6)}" rx="${span(18)}" ry="${H * 0.02}" fill="#4a6a28" opacity="0.7"/>
     <ellipse cx="${X(20)}" cy="${Y(2)}" rx="${span(10)}" ry="${H * 0.04}" fill="#3d6b32"/>
     ${northMark()}`,
  );
}

/** Pin centres match these room boxes (fractions of 1600×1100). */
const HOUSE_PINS = {
  '01 hall': { x: 0.5, y: 0.52 },
  '02 kitchen': { x: 0.22, y: 0.52 },
  '03 living': { x: 0.5, y: 0.26 },
  '04 bedroom': { x: 0.78, y: 0.52 },
  '05 garden': { x: 0.5, y: 0.78 },
} as const;

function housePlan() {
  const PW = 1600;
  const PH = 1100;
  const room = (x: number, y: number, w: number, h: number, fill: string, name: string) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" stroke="#2c2a26" stroke-width="10"/>
     <text x="${x + w / 2}" y="${y + h / 2 - 8}" text-anchor="middle" font-family="Georgia, serif" font-size="36" font-weight="700" fill="#3a332c">${name}</text>`;
  const doorGap = (x: number, y: number, w: number, h: number) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#efe6d4"/>`;
  const win = (x: number, y: number, w: number, h: number) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#9ec4e6" stroke="#2c2a26" stroke-width="4"/>`;
  const svgPlan = `<svg xmlns="http://www.w3.org/2000/svg" width="${PW}" height="${PH}" viewBox="0 0 ${PW} ${PH}">
    <rect width="${PW}" height="${PH}" fill="#f3eadc"/>
    <rect x="48" y="36" width="1504" height="1028" rx="18" fill="#efe6d4" stroke="#d4c4aa" stroke-width="2"/>
    <text x="80" y="88" font-family="Georgia, serif" font-size="34" font-weight="700" fill="#3a332c">Willow House</text>
    <text x="80" y="122" font-family="Georgia, serif" font-size="18" fill="#6b6258">Ground floor · north up</text>
    <polygon points="1480,70 1504,118 1456,118" fill="#ef4444"/>
    <text x="1480" y="148" text-anchor="middle" font-family="Georgia, serif" font-size="18" fill="#ef4444">N</text>
    ${room(200, 140, 1200, 280, '#e8d9c4', 'Living')}
    ${room(200, 420, 400, 340, '#dce6e3', 'Kitchen')}
    ${room(600, 420, 400, 340, '#efe6d4', 'Hall')}
    ${room(1000, 420, 400, 340, '#e4d8e8', 'Bedroom')}
    ${room(600, 760, 400, 220, '#c5d4a8', 'Garden')}
    ${doorGap(590, 530, 22, 90)}
    ${doorGap(988, 530, 24, 90)}
    ${doorGap(760, 410, 90, 22)}
    ${doorGap(760, 750, 90, 22)}
    ${win(430, 132, 120, 16)}
    ${win(1050, 132, 120, 16)}
    ${win(192, 530, 16, 90)}
    ${win(1392, 530, 16, 90)}
    ${win(740, 972, 120, 16)}
    <circle cx="${0.5 * PW}" cy="${0.26 * PH}" r="8" fill="#0ea5e9"/>
    <circle cx="${0.22 * PW}" cy="${0.52 * PH}" r="8" fill="#0ea5e9"/>
    <circle cx="${0.5 * PW}" cy="${0.52 * PH}" r="8" fill="#0ea5e9"/>
    <circle cx="${0.78 * PW}" cy="${0.52 * PH}" r="8" fill="#0ea5e9"/>
    <circle cx="${0.5 * PW}" cy="${0.78 * PH}" r="8" fill="#0ea5e9"/>
  </svg>`;
  return Buffer.from(svgPlan);
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const outputs: [string, () => Promise<Buffer>][] = [
    ['01-hall.jpg', () => sharp(hall()).jpeg({ quality: 88, mozjpeg: true }).toBuffer()],
    ['02-kitchen.png', () => sharp(kitchen()).png({ compressionLevel: 9 }).toBuffer()],
    ['03-living.jpg', () => sharp(living()).jpeg({ quality: 88, mozjpeg: true }).toBuffer()],
    ['04-bedroom.webp', () => sharp(bedroom()).webp({ quality: 88 }).toBuffer()],
    ['05-garden.jpg', () => sharp(garden()).jpeg({ quality: 88, mozjpeg: true }).toBuffer()],
    [
      'floor-plan.webp',
      () => sharp(housePlan()).webp({ quality: 90 }).toBuffer(),
    ],
    [
      'invalid-portrait.jpg',
      () =>
        sharp({
          create: { width: 2000, height: 3000, channels: 3, background: '#7a8a99' },
        })
          .composite([
            {
              input: Buffer.from(
                `<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="3000"><text x="1000" y="1500" font-family="Helvetica, Arial, sans-serif" font-size="96" font-weight="700" fill="#fff" text-anchor="middle">Portrait — should be rejected</text></svg>`,
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
  await writeFile(
    resolve(outDir, 'floor-plan.json'),
    `${JSON.stringify({ width: 1600, height: 1100, pins: HOUSE_PINS }, null, 2)}\n`,
  );
  console.info(`  ✓ floor-plan.json`);
  console.info(`\nWrote ${outputs.length} images to ${outDir}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
