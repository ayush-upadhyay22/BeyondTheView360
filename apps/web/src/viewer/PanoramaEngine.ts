import * as THREE from 'three';
import {
  clamp,
  DEFAULT_FOV,
  MAX_FOV,
  MIN_FOV,
  normalizeYaw,
  vectorToYawPitch,
  yawPitchToVector,
  type View,
} from '@btv/shared';

export interface ScreenPoint {
  x: number;
  y: number;
  visible: boolean;
}

export interface StereoMarker {
  id: string;
  yaw: number;
  pitch: number;
  kind: 'link' | 'info';
}

export interface EngineOptions {
  reducedMotion: boolean;
  autorotate: boolean;
  /** Degrees per second. */
  autorotateSpeed?: number;
  onViewChange?: (view: View) => void;
  /** A click/tap that was not a drag. */
  onClick?: (pos: { yaw: number; pitch: number }) => void;
  /** Fired in stereo mode when the user gazes at a link marker long enough. */
  onGazeActivate?: (markerId: string) => void;
  /** Called on any user-initiated camera movement (used to stop autorotate in the UI). */
  onInteract?: () => void;
}

const MAX_PITCH = 89;
const CACHE_SIZE = 5;
const GAZE_ANGLE = 5;
const GAZE_MS = 1500;

export class WebGLUnavailableError extends Error {
  constructor() {
    super('WebGL is not available in this browser.');
    this.name = 'WebGLUnavailableError';
  }
}

interface CachedTexture {
  texture: THREE.Texture;
  lastUsed: number;
}

/**
 * Imperative Three.js panorama renderer. The React layer owns DOM/UI; this class owns the
 * canvas, camera maths, input handling and texture lifecycle.
 */
export class PanoramaEngine {
  readonly canvas: HTMLCanvasElement;
  readonly maxTextureSize: number;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly stereo = new THREE.StereoCamera();
  private readonly material: THREE.MeshBasicMaterial;
  private readonly sphere: THREE.Mesh;
  private readonly markerGroup = new THREE.Group();
  private readonly textures = new Map<string, CachedTexture>();
  private readonly loading = new Map<string, Promise<THREE.Texture>>();
  private readonly loader = new THREE.TextureLoader();
  private readonly frameListeners = new Set<() => void>();
  private readonly resizeObserver: ResizeObserver;

  private yaw = 0;
  private pitch = 0;
  private fov = DEFAULT_FOV;
  private velocity = { yaw: 0, pitch: 0 };
  private autorotate: boolean;
  private stereoMode = false;
  private dirty = true;
  private raf = 0;
  private lastTime = performance.now();
  private loadToken = 0;
  private disposed = false;
  private viewChangeTimer: ReturnType<typeof setTimeout> | undefined;

  private pointers = new Map<number, { x: number; y: number }>();
  private dragStart: { x: number; y: number; t: number; moved: number } | null = null;
  private pinchStart: { dist: number; fov: number } | null = null;
  private lastMove: { t: number; dYaw: number; dPitch: number } | null = null;

  private gyro: {
    active: boolean;
    q: THREE.Quaternion;
    hasReading: boolean;
    yawOffset: number;
    pitchOffset: number;
  } = { active: false, q: new THREE.Quaternion(), hasReading: false, yawOffset: 0, pitchOffset: 0 };
  private screenOrientation = 0;

  private gaze: { id: string; since: number } | null = null;
  private markers: StereoMarker[] = [];

  constructor(
    private readonly container: HTMLElement,
    private options: EngineOptions,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'block h-full w-full touch-none select-none';
    this.canvas.setAttribute('aria-hidden', 'true');

    try {
      this.renderer = new THREE.WebGLRenderer({
        canvas: this.canvas,
        antialias: false,
        alpha: false,
        powerPreference: 'high-performance',
      });
    } catch {
      throw new WebGLUnavailableError();
    }
    container.appendChild(this.canvas);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.maxTextureSize = this.renderer.capabilities.maxTextureSize;

    this.camera = new THREE.PerspectiveCamera(this.fov, 1, 0.1, 1100);
    this.stereo.eyeSep = 0.064;

    const geometry = new THREE.SphereGeometry(500, 96, 64);
    geometry.scale(-1, 1, 1); // view the sphere from inside
    this.material = new THREE.MeshBasicMaterial({ color: 0x0b1220 });
    this.sphere = new THREE.Mesh(geometry, this.material);
    // Puts the horizontal centre of the equirectangular image at yaw 0 (-Z).
    this.sphere.rotation.y = -Math.PI / 2;
    this.scene.add(this.sphere);
    this.markerGroup.visible = false;
    this.scene.add(this.markerGroup);

    this.loader.setCrossOrigin('anonymous');
    this.autorotate = options.autorotate && !options.reducedMotion;

    this.bindInput();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.loop();
  }

  // ---------------------------------------------------------------- public API

  setOptions(patch: Partial<EngineOptions>) {
    this.options = { ...this.options, ...patch };
  }

  getView(): View {
    return { yaw: normalizeYaw(this.yaw), pitch: this.pitch, fov: this.fov };
  }

  setView(view: Partial<View>) {
    if (view.yaw !== undefined) this.yaw = normalizeYaw(view.yaw);
    if (view.pitch !== undefined) this.pitch = clamp(view.pitch, -MAX_PITCH, MAX_PITCH);
    if (view.fov !== undefined) this.fov = clamp(view.fov, MIN_FOV, MAX_FOV);
    this.velocity = { yaw: 0, pitch: 0 };
    if (this.gyro.active) this.recalibrateGyro();
    this.invalidate(true);
  }

  rotateBy(dYaw: number, dPitch: number) {
    this.stopAutorotate();
    this.yaw = normalizeYaw(this.yaw + dYaw);
    this.pitch = clamp(this.pitch + dPitch, -MAX_PITCH, MAX_PITCH);
    if (this.gyro.active) {
      this.gyro.yawOffset += dYaw;
    }
    this.invalidate(true);
  }

  zoomBy(deltaFov: number) {
    this.fov = clamp(this.fov + deltaFov, MIN_FOV, MAX_FOV);
    this.invalidate(true);
  }

  setAutorotate(on: boolean) {
    this.autorotate = on && !this.options.reducedMotion;
    this.invalidate();
  }

  isAutorotating() {
    return this.autorotate;
  }

  setStereo(on: boolean) {
    this.stereoMode = on;
    this.markerGroup.visible = on;
    this.gaze = null;
    this.resize();
  }

  /** Hotspot markers rendered inside the 3D scene (only visible in stereo/VR mode). */
  setStereoMarkers(markers: StereoMarker[]) {
    this.markers = markers;
    for (const child of [...this.markerGroup.children]) {
      this.markerGroup.remove(child);
      (child as THREE.Sprite).material.dispose();
    }
    for (const m of markers) {
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: markerTexture(m.kind), depthTest: false }),
      );
      const [x, y, z] = yawPitchToVector(m.yaw, m.pitch);
      sprite.position.set(x * 400, y * 400, z * 400);
      sprite.scale.setScalar(28);
      this.markerGroup.add(sprite);
    }
    this.invalidate();
  }

  /** Projects a direction to container pixels. */
  project(yaw: number, pitch: number): ScreenPoint {
    const [x, y, z] = yawPitchToVector(yaw, pitch);
    const dir = new THREE.Vector3(x, y, z);
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    const p = dir.clone().multiplyScalar(100).project(this.camera);
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const visible = dir.dot(forward) > 0.05 && Math.abs(p.x) <= 1.2 && Math.abs(p.y) <= 1.2;
    return { x: ((p.x + 1) / 2) * w, y: ((1 - p.y) / 2) * h, visible };
  }

  /** Converts a viewport (client) point into yaw/pitch. */
  unproject(clientX: number, clientY: number): { yaw: number; pitch: number } {
    const rect = this.container.getBoundingClientRect();
    const ndc = new THREE.Vector3(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
      0.5,
    );
    ndc.unproject(this.camera).normalize();
    const r = vectorToYawPitch(ndc.x, ndc.y, ndc.z);
    return { yaw: Math.round(r.yaw * 100) / 100, pitch: Math.round(r.pitch * 100) / 100 };
  }

  onFrame(listener: () => void): () => void {
    this.frameListeners.add(listener);
    this.invalidate();
    return () => this.frameListeners.delete(listener);
  }

  /**
   * Shows `placeholderUrl` immediately (if given), then swaps in `url` once loaded.
   * Superseded loads are ignored, so rapid scene switching is safe.
   */
  async showImage(key: string, url: string, placeholderUrl?: string | null): Promise<void> {
    const token = ++this.loadToken;
    const cached = this.textures.get(key);
    if (cached) {
      this.applyTexture(cached.texture, key);
      return;
    }
    if (placeholderUrl) {
      this.loadTexture(`${key}:placeholder`, placeholderUrl)
        .then((t) => {
          if (token === this.loadToken && !this.textures.has(key)) this.applyTexture(t);
        })
        .catch(() => undefined);
    } else {
      this.material.map = null;
      this.material.color.set(0x0b1220);
      this.material.needsUpdate = true;
      this.invalidate();
    }
    const texture = await this.loadTexture(key, url);
    if (token === this.loadToken && !this.disposed) this.applyTexture(texture, key);
  }

  /** Warms the cache for a scene the user is likely to open next. */
  preload(key: string, url: string): void {
    if (this.textures.has(key) || this.loading.has(key)) return;
    this.loadTexture(key, url).catch(() => undefined);
  }

  /** Must be called from a user gesture (iOS permission prompt). */
  async enableGyro(): Promise<boolean> {
    type IOSOrientationEvent = typeof DeviceOrientationEvent & {
      requestPermission?: () => Promise<'granted' | 'denied'>;
    };
    const DOE = window.DeviceOrientationEvent as IOSOrientationEvent | undefined;
    if (!DOE) return false;
    if (typeof DOE.requestPermission === 'function') {
      try {
        if ((await DOE.requestPermission()) !== 'granted') return false;
      } catch {
        return false;
      }
    }
    this.gyro.active = true;
    this.gyro.hasReading = false;
    window.addEventListener('deviceorientation', this.onDeviceOrientation);
    window.addEventListener('orientationchange', this.onScreenOrientation);
    this.onScreenOrientation();
    return true;
  }

  disableGyro() {
    this.gyro.active = false;
    window.removeEventListener('deviceorientation', this.onDeviceOrientation);
    window.removeEventListener('orientationchange', this.onScreenOrientation);
    this.invalidate();
  }

  invalidate(userChange = false) {
    this.dirty = true;
    if (userChange) this.emitViewChange();
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.viewChangeTimer);
    this.resizeObserver.disconnect();
    this.disableGyro();
    this.unbindInput();
    for (const { texture } of this.textures.values()) texture.dispose();
    this.textures.clear();
    this.setStereoMarkers([]);
    this.sphere.geometry.dispose();
    this.material.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }

  // ---------------------------------------------------------------- textures

  private loadTexture(key: string, url: string): Promise<THREE.Texture> {
    const existing = this.textures.get(key);
    if (existing) {
      existing.lastUsed = performance.now();
      return Promise.resolve(existing.texture);
    }
    const pending = this.loading.get(key);
    if (pending) return pending;
    const promise = new Promise<THREE.Texture>((resolve, reject) => {
      this.loader.load(
        url,
        (texture) => {
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.minFilter = THREE.LinearFilter;
          texture.generateMipmaps = false;
          texture.anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy());
          this.textures.set(key, { texture, lastUsed: performance.now() });
          this.evict();
          resolve(texture);
        },
        undefined,
        () => reject(new Error(`Failed to load panorama image`)),
      );
    }).finally(() => this.loading.delete(key));
    this.loading.set(key, promise);
    return promise;
  }

  private evict() {
    if (this.textures.size <= CACHE_SIZE) return;
    const current = this.material.map;
    const sorted = [...this.textures.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [key, entry] of sorted) {
      if (this.textures.size <= CACHE_SIZE) break;
      if (entry.texture === current) continue;
      entry.texture.dispose();
      this.textures.delete(key);
    }
  }

  private applyTexture(texture: THREE.Texture, key?: string) {
    if (key) {
      const entry = this.textures.get(key);
      if (entry) entry.lastUsed = performance.now();
    }
    this.material.map = texture;
    this.material.color.set(0xffffff);
    this.material.needsUpdate = true;
    this.invalidate();
  }

  // ---------------------------------------------------------------- input

  private bindInput() {
    const c = this.container;
    c.addEventListener('pointerdown', this.onPointerDown);
    c.addEventListener('pointermove', this.onPointerMove);
    c.addEventListener('pointerup', this.onPointerUp);
    c.addEventListener('pointercancel', this.onPointerUp);
    c.addEventListener('wheel', this.onWheel, { passive: false });
  }

  private unbindInput() {
    const c = this.container;
    c.removeEventListener('pointerdown', this.onPointerDown);
    c.removeEventListener('pointermove', this.onPointerMove);
    c.removeEventListener('pointerup', this.onPointerUp);
    c.removeEventListener('pointercancel', this.onPointerUp);
    c.removeEventListener('wheel', this.onWheel);
  }

  private isOverlayTarget(e: Event) {
    const target = e.target as HTMLElement | null;
    return !!target?.closest('[data-viewer-ui]');
  }

  private onPointerDown = (e: PointerEvent) => {
    if (this.isOverlayTarget(e) || e.button > 0) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.container.setPointerCapture?.(e.pointerId);
    this.velocity = { yaw: 0, pitch: 0 };
    if (this.pointers.size === 1) {
      this.dragStart = { x: e.clientX, y: e.clientY, t: performance.now(), moved: 0 };
    } else if (this.pointers.size === 2) {
      this.pinchStart = { dist: this.pointerDistance(), fov: this.fov };
      this.dragStart = null;
    }
  };

  private onPointerMove = (e: PointerEvent) => {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    const now = { x: e.clientX, y: e.clientY };
    this.pointers.set(e.pointerId, now);

    if (this.pointers.size >= 2 && this.pinchStart) {
      const dist = this.pointerDistance();
      if (dist > 0) {
        this.fov = clamp((this.pinchStart.fov * this.pinchStart.dist) / dist, MIN_FOV, MAX_FOV);
        this.notifyInteract();
        this.invalidate(true);
      }
      return;
    }
    if (!this.dragStart) return;
    const dx = now.x - prev.x;
    const dy = now.y - prev.y;
    this.dragStart.moved += Math.abs(dx) + Math.abs(dy);
    // Grab-and-drag: content follows the pointer. Degrees per pixel = vertical FOV / height.
    const k = this.fov / Math.max(1, this.container.clientHeight);
    const dYaw = -dx * k;
    const dPitch = dy * k;
    if (this.dragStart.moved > 3) this.notifyInteract();
    this.rotateBy(dYaw, dPitch);
    this.lastMove = { t: performance.now(), dYaw, dPitch };
  };

  private onPointerUp = (e: PointerEvent) => {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinchStart = null;
    const start = this.dragStart;
    if (start && this.pointers.size === 0) {
      const isClick = start.moved < 6 && performance.now() - start.t < 600;
      if (isClick) {
        this.options.onClick?.(this.unproject(e.clientX, e.clientY));
      } else if (!this.options.reducedMotion && this.lastMove) {
        // Inertia from the last movement sample (ignored if the pointer paused before release).
        const age = performance.now() - this.lastMove.t;
        if (age < 80) {
          this.velocity = { yaw: this.lastMove.dYaw / 16, pitch: this.lastMove.dPitch / 16 };
        }
      }
      this.dragStart = null;
      this.lastMove = null;
    }
  };

  private onWheel = (e: WheelEvent) => {
    if (this.isOverlayTarget(e)) return;
    e.preventDefault();
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    this.notifyInteract();
    this.zoomBy(clamp(delta, -100, 100) * 0.05);
  };

  private pointerDistance() {
    const [a, b] = [...this.pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }

  private notifyInteract() {
    this.stopAutorotate();
    this.options.onInteract?.();
  }

  private stopAutorotate() {
    this.autorotate = false;
  }

  // ---------------------------------------------------------------- gyroscope

  private onScreenOrientation = () => {
    const angle =
      (screen.orientation?.angle ?? (window as { orientation?: number }).orientation ?? 0) || 0;
    this.screenOrientation = THREE.MathUtils.degToRad(angle);
  };

  private onDeviceOrientation = (e: DeviceOrientationEvent) => {
    if (e.alpha === null || e.beta === null || e.gamma === null) return;
    const euler = new THREE.Euler(
      THREE.MathUtils.degToRad(e.beta),
      THREE.MathUtils.degToRad(e.alpha),
      THREE.MathUtils.degToRad(-e.gamma),
      'YXZ',
    );
    const q = new THREE.Quaternion().setFromEuler(euler);
    q.multiply(new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5))); // camera looks out the back
    q.multiply(
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -this.screenOrientation),
    );
    this.gyro.q.copy(q);
    if (!this.gyro.hasReading) {
      this.gyro.hasReading = true;
      this.recalibrateGyro();
    }
    this.dirty = true;
  };

  /** Keeps the current view when the gyroscope takes over (or after a programmatic jump). */
  private recalibrateGyro() {
    if (!this.gyro.hasReading) return;
    const raw = this.gyroYawPitch();
    this.gyro.yawOffset = this.yaw - raw.yaw;
    this.gyro.pitchOffset = 0;
  }

  private gyroYawPitch() {
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.gyro.q);
    return vectorToYawPitch(dir.x, dir.y, dir.z);
  }

  // ---------------------------------------------------------------- render loop

  private resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = this.stereoMode ? w / 2 / h : w / h;
    this.dirty = true;
  }

  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min(64, now - this.lastTime);
    this.lastTime = now;

    let moving = false;
    if (this.autorotate && this.pointers.size === 0 && !this.gyro.active) {
      this.yaw = normalizeYaw(this.yaw + ((this.options.autorotateSpeed ?? 3) * dt) / 1000);
      moving = true;
    }
    if (Math.abs(this.velocity.yaw) + Math.abs(this.velocity.pitch) > 0.0005) {
      this.yaw = normalizeYaw(this.yaw + this.velocity.yaw * dt);
      this.pitch = clamp(this.pitch + this.velocity.pitch * dt, -MAX_PITCH, MAX_PITCH);
      const decay = Math.pow(0.9, dt / 16);
      this.velocity.yaw *= decay;
      this.velocity.pitch *= decay;
      moving = true;
      if (Math.abs(this.velocity.yaw) + Math.abs(this.velocity.pitch) <= 0.0005) {
        this.emitViewChange();
      }
    }
    if (this.gyro.active && this.gyro.hasReading) {
      const raw = this.gyroYawPitch();
      this.yaw = normalizeYaw(raw.yaw + this.gyro.yawOffset);
      this.pitch = clamp(raw.pitch, -MAX_PITCH, MAX_PITCH);
      moving = true;
    }
    if (this.stereoMode) this.updateGaze(now);

    if (!this.dirty && !moving) return;
    this.dirty = false;
    this.render();
    for (const listener of this.frameListeners) listener();
  };

  private render() {
    const [x, y, z] = yawPitchToVector(this.yaw, this.pitch);
    this.camera.fov = this.fov;
    this.camera.updateProjectionMatrix();
    this.camera.position.set(0, 0, 0);
    this.camera.lookAt(x, y, z);
    this.camera.updateMatrixWorld();

    if (!this.stereoMode) {
      this.renderer.setScissorTest(false);
      this.renderer.setViewport(0, 0, this.container.clientWidth, this.container.clientHeight);
      this.renderer.render(this.scene, this.camera);
      return;
    }
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.stereo.update(this.camera);
    this.renderer.setScissorTest(true);
    this.renderer.setScissor(0, 0, w / 2, h);
    this.renderer.setViewport(0, 0, w / 2, h);
    this.renderer.render(this.scene, this.stereo.cameraL);
    this.renderer.setScissor(w / 2, 0, w / 2, h);
    this.renderer.setViewport(w / 2, 0, w / 2, h);
    this.renderer.render(this.scene, this.stereo.cameraR);
    this.renderer.setScissorTest(false);
  }

  private updateGaze(now: number) {
    const view = { yaw: this.yaw, pitch: this.pitch };
    const target = this.markers.find(
      (m) => m.kind === 'link' && angleBetween(view, m) < GAZE_ANGLE,
    );
    if (!target) {
      this.gaze = null;
      return;
    }
    if (!this.gaze || this.gaze.id !== target.id) {
      this.gaze = { id: target.id, since: now };
      return;
    }
    if (now - this.gaze.since > GAZE_MS) {
      this.gaze = null;
      this.options.onGazeActivate?.(target.id);
    }
  }

  private emitViewChange() {
    if (!this.options.onViewChange) return;
    clearTimeout(this.viewChangeTimer);
    this.viewChangeTimer = setTimeout(() => this.options.onViewChange?.(this.getView()), 120);
  }
}

function angleBetween(a: { yaw: number; pitch: number }, b: { yaw: number; pitch: number }) {
  const [ax, ay, az] = yawPitchToVector(a.yaw, a.pitch);
  const [bx, by, bz] = yawPitchToVector(b.yaw, b.pitch);
  return THREE.MathUtils.radToDeg(Math.acos(clamp(ax * bx + ay * by + az * bz, -1, 1)));
}

const markerTextures = new Map<string, THREE.Texture>();

/** Simple procedurally drawn marker for VR mode (no image assets). */
function markerTexture(kind: 'link' | 'info'): THREE.Texture {
  const cached = markerTextures.get(kind);
  if (cached) return cached;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 8, 0, Math.PI * 2);
  ctx.fillStyle = kind === 'link' ? 'rgba(14,165,233,0.85)' : 'rgba(245,158,11,0.9)';
  ctx.fill();
  ctx.lineWidth = 8;
  ctx.strokeStyle = 'white';
  ctx.stroke();
  ctx.fillStyle = 'white';
  ctx.font = 'bold 64px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(kind === 'link' ? '↑' : 'i', size / 2, size / 2 + 4);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  markerTextures.set(kind, texture);
  return texture;
}
