import type { ViewerSceneDTO } from '@btv/shared';

/**
 * Draws an original synthetic equirectangular test panorama on a canvas: gradient sky, sun,
 * horizon, a perspective floor grid, a yaw/pitch graticule and compass labels
 * (N at yaw 0 = image centre, E at +90°, S at ±180°, W at -90°).
 */
function drawPanorama(variant: 'day' | 'dusk', width = 4096): string {
  const height = width / 2;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const u = (yaw: number) => ((yaw + 180) / 360) * width;
  const v = (pitch: number) => ((90 - pitch) / 180) * height;

  const sky = ctx.createLinearGradient(0, 0, 0, height / 2);
  if (variant === 'day') {
    sky.addColorStop(0, '#0b3d91');
    sky.addColorStop(0.7, '#5aa9e6');
    sky.addColorStop(1, '#dff3ff');
  } else {
    sky.addColorStop(0, '#120c2c');
    sky.addColorStop(0.6, '#7a2e6b');
    sky.addColorStop(1, '#ffb36b');
  }
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height / 2);

  const ground = ctx.createLinearGradient(0, height / 2, 0, height);
  ground.addColorStop(0, variant === 'day' ? '#3f6b3a' : '#3a2a3f');
  ground.addColorStop(1, variant === 'day' ? '#1f3320' : '#140d17');
  ctx.fillStyle = ground;
  ctx.fillRect(0, height / 2, width, height / 2);

  // Sun
  const sunX = u(variant === 'day' ? 45 : -60);
  const sunY = v(variant === 'day' ? 35 : 6);
  const glow = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, width * 0.05);
  glow.addColorStop(0, 'rgba(255,250,220,1)');
  glow.addColorStop(0.3, 'rgba(255,220,150,0.8)');
  glow.addColorStop(1, 'rgba(255,200,120,0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(sunX, sunY, width * 0.05, 0, Math.PI * 2);
  ctx.fill();

  // Graticule every 15° (thicker every 45°)
  for (let yaw = -180; yaw <= 180; yaw += 15) {
    ctx.strokeStyle = yaw % 45 === 0 ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.12)';
    ctx.lineWidth = yaw % 45 === 0 ? 3 : 1.5;
    ctx.beginPath();
    ctx.moveTo(u(yaw), 0);
    ctx.lineTo(u(yaw), height);
    ctx.stroke();
  }
  for (let pitch = -75; pitch <= 75; pitch += 15) {
    ctx.strokeStyle = pitch === 0 ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.12)';
    ctx.lineWidth = pitch === 0 ? 4 : 1.5;
    ctx.beginPath();
    ctx.moveTo(0, v(pitch));
    ctx.lineTo(width, v(pitch));
    ctx.stroke();
  }

  // Compass labels on the horizon
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const labels: [number, string, string][] = [
    [0, 'N', '#f87171'],
    [90, 'E', '#ffffff'],
    [180, 'S', '#ffffff'],
    [-180, 'S', '#ffffff'],
    [-90, 'W', '#ffffff'],
  ];
  for (const [yaw, text, color] of labels) {
    ctx.font = `bold ${Math.round(width / 28)}px system-ui, sans-serif`;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillText(text, u(yaw) + 4, v(8) + 4);
    ctx.fillStyle = color;
    ctx.fillText(text, u(yaw), v(8));
  }
  ctx.font = `${Math.round(width / 120)}px system-ui, sans-serif`;
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  for (let yaw = -165; yaw <= 180; yaw += 15) {
    if (yaw % 90 === 0) continue;
    ctx.fillText(`${yaw}°`, u(yaw), v(-4));
  }
  ctx.font = `600 ${Math.round(width / 60)}px system-ui, sans-serif`;
  ctx.fillText(variant === 'day' ? 'Demo · Daylight' : 'Demo · Dusk', u(0), v(-30));
  return canvas.toDataURL('image/jpeg', 0.9);
}

/** Two linked demo scenes, built entirely in the browser. */
export function createDemoScenes(): ViewerSceneDTO[] {
  const day = drawPanorama('day');
  const dusk = drawPanorama('dusk');
  const base = {
    width: 4096,
    height: 2048,
    northOffset: 0,
    placeholder: null,
    startView: null,
    mapX: null,
    mapY: null,
  };
  return [
    {
      ...base,
      id: 'demo-day',
      name: 'Daylight',
      thumbUrl: day,
      variants: [{ width: 4096, url: day }],
      hotspots: [
        {
          id: 'demo-link-1',
          sceneId: 'demo-day',
          kind: 'next',
          yaw: 120,
          pitch: -10,
          title: 'Walk to dusk',
          text: '',
          imageUrl: null,
          targetSceneId: 'demo-dusk',
        },
        {
          id: 'demo-info-1',
          sceneId: 'demo-day',
          kind: 'info',
          yaw: 0,
          pitch: 20,
          title: 'This is north',
          text: 'Labels on the horizon show the compass directions. Drag to look around, scroll or pinch to zoom.',
          imageUrl: null,
          targetSceneId: null,
        },
      ],
    },
    {
      ...base,
      id: 'demo-dusk',
      name: 'Dusk',
      thumbUrl: dusk,
      variants: [{ width: 4096, url: dusk }],
      hotspots: [
        {
          id: 'demo-link-2',
          sceneId: 'demo-dusk',
          kind: 'back',
          yaw: -60,
          pitch: -10,
          title: 'Back to daylight',
          text: '',
          imageUrl: null,
          targetSceneId: 'demo-day',
        },
      ],
    },
  ];
}
