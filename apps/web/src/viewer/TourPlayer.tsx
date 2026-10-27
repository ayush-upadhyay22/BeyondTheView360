import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  arrivalYaw,
  DEFAULT_FOV,
  GUIDED_DWELL_MS,
  GUIDED_ROTATE_SPEED,
  normalizeYaw,
  selectVariant,
  walkInDuration,
  walkInPose,
  walkOutDuration,
  walkOutPose,
  WALK_PITCH,
  zoomedFov,
  type FloorPlanDTO,
  type HotspotDTO,
  type View,
  type ViewerSceneDTO,
  type WalkPose,
} from '@btv/shared';
import {
  ChevronDownIcon,
  ChevronUpIcon,
  CloseIcon,
  ExpandIcon,
  GogglesIcon,
  HdIcon,
  MinusIcon,
  PhoneTiltIcon,
  PlayIcon,
  PlusIcon,
  RefreshIcon,
  RotateIcon,
  ShrinkIcon,
  StopIcon,
} from '../components/icons';
import { PanoramaEngine, WebGLUnavailableError } from './PanoramaEngine';
import { HotspotLayer } from './HotspotLayer';
import { MiniMap } from './MiniMap';
import { deviceProfile, prefersReducedMotion, supportsGyroscope } from './device';

export interface TourPlayerHandle {
  getView: () => View | null;
  setView: (view: Partial<View>) => void;
  /** Viewport point → panorama direction (for drops onto the viewer). */
  unproject: (clientX: number, clientY: number) => { yaw: number; pitch: number } | null;
  walkTo: (sceneId: string, walkYaw?: number) => void;
}

export interface TourPlayerProps {
  scenes: ViewerSceneDTO[];
  startSceneId?: string | null;
  /** Initial view for the first scene shown (tour start view). */
  startView?: View | null;
  /** Controlled current scene (editor). */
  sceneId?: string | null;
  onSceneChange?: (sceneId: string) => void;
  /** "full" = public page, "minimal" = editor preview, "none" = no controls at all (?ui=0). */
  chrome?: 'full' | 'minimal' | 'none';
  title?: string;
  autorotate?: boolean;
  /** Start the guided walk as soon as the first scene is visible (?autoplay=1). */
  autoplay?: boolean;
  floorPlan?: FloorPlanDTO | null;
  /** Edit mode: hotspots are draggable and clicking them selects instead of navigating. */
  editable?: boolean;
  selectedHotspotId?: string | null;
  onHotspotSelect?: (hotspot: HotspotDTO) => void;
  onHotspotMove?: (hotspot: HotspotDTO, pos: { yaw: number; pitch: number }) => void;
  onViewerClick?: (pos: { yaw: number; pitch: number }) => void;
  onViewChange?: (view: View) => void;
  crosshair?: boolean;
  emptyState?: ReactNode;
  className?: string;
  /** Extra overlay content (e.g. editor hints). */
  children?: ReactNode;
}

type EngineState =
  { status: 'starting' } | { status: 'ready' } | { status: 'error'; message: string };

/** Give up waiting for the next room's image after this long (the scene then shows its error). */
const WALK_LOAD_TIMEOUT_MS = 15_000;
/** Linked scenes preloaded per room (next/back first). */
const PRELOAD_LIMIT = 4;

const textureKey = (sceneId: string, width: number) => `${sceneId}:${width}`;

function animate(durationMs: number, frame: (elapsed: number) => void): Promise<void> {
  return new Promise((resolve) => {
    const start = performance.now();
    const step = () => {
      const elapsed = performance.now() - start;
      frame(Math.min(elapsed, durationMs));
      if (elapsed >= durationMs) resolve();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/** The scene's own "next" arrow (guided walk follows it). */
export function nextArrow(scene: ViewerSceneDTO, scenes: ViewerSceneDTO[]) {
  return scene.hotspots.find(
    (h) => h.kind === 'next' && h.targetSceneId && scenes.some((s) => s.id === h.targetSceneId),
  );
}

export const TourPlayer = forwardRef<TourPlayerHandle, TourPlayerProps>(function TourPlayer(
  {
    scenes,
    startSceneId,
    startView,
    sceneId: controlledSceneId,
    onSceneChange,
    chrome = 'full',
    title,
    autorotate = true,
    autoplay = false,
    floorPlan,
    editable = false,
    selectedHotspotId,
    onHotspotSelect,
    onHotspotMove,
    onViewerClick,
    onViewChange,
    crosshair,
    emptyState,
    className = '',
    children,
  },
  ref,
) {
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<PanoramaEngine | null>(null);
  const [engine, setEngine] = useState<PanoramaEngine | null>(null);
  const [engineState, setEngineState] = useState<EngineState>({ status: 'starting' });
  const reducedMotion = useMemo(prefersReducedMotion, []);

  const [internalSceneId, setInternalSceneId] = useState<string | null>(() =>
    startSceneId && scenes.some((s) => s.id === startSceneId)
      ? startSceneId
      : (scenes[0]?.id ?? null),
  );
  const currentId = controlledSceneId !== undefined ? controlledSceneId : internalSceneId;
  const scene = scenes.find((s) => s.id === currentId) ?? scenes[0] ?? null;

  const [hd, setHd] = useState(false);
  const [rotating, setRotating] = useState(autorotate && !reducedMotion);
  const [gyroOn, setGyroOn] = useState(false);
  const [stereo, setStereo] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [pseudoFullscreen, setPseudoFullscreen] = useState(false);
  const [stripOpen, setStripOpen] = useState(true);
  const [openInfo, setOpenInfo] = useState<HotspotDTO | null>(null);
  const [imageState, setImageState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [heading, setHeading] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const [walking, setWalking] = useState(false);
  const [walkLoading, setWalkLoading] = useState(false);
  const [guided, setGuided] = useState(false);

  const pendingView = useRef<Partial<View> | null>(startView ?? null);
  const shownSceneId = useRef<string | null>(null);
  const walkingRef = useRef(false);
  const guidedRef = useRef(false);
  guidedRef.current = guided;
  /** Resolved by the scene effect once a walk's target scene is on screen. */
  const arrival = useRef<{ sceneId: string; resolve: () => void } | null>(null);
  const mounted = useRef(true);
  const callbacks = useRef({ onViewerClick, onViewChange, onSceneChange });
  callbacks.current = { onViewerClick, onViewChange, onSceneChange };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // ------------------------------------------------------------------ engine lifecycle
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let created: PanoramaEngine;
    try {
      created = new PanoramaEngine(stage, {
        reducedMotion,
        autorotate: autorotate && !reducedMotion,
        onClick: (pos) => callbacks.current.onViewerClick?.(pos),
        onViewChange: (v) => callbacks.current.onViewChange?.(v),
        onInteract: () => {
          setRotating(false);
          setGuided(false);
        },
      });
    } catch (err) {
      setEngineState({
        status: 'error',
        message:
          err instanceof WebGLUnavailableError
            ? 'Your browser or device does not support WebGL, which is needed to show 360° images.'
            : 'The 360° viewer could not start.',
      });
      return;
    }
    engineRef.current = created;
    setEngine(created);
    setEngineState({ status: 'ready' });
    return () => {
      created.dispose();
      engineRef.current = null;
      setEngine(null);
    };
    // The engine is created once; later prop changes are pushed through setters below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Autorotate: the user's toggle, or the slow spin of the guided walk (never mid-walk).
  useEffect(() => {
    if (!engine) return;
    engine.setOptions({ autorotateSpeed: guided ? GUIDED_ROTATE_SPEED : 3 });
    engine.setAutorotate((rotating || guided) && !walking);
  }, [engine, rotating, guided, walking]);

  // Heading for the compass and the mini-map view cone, sampled each frame.
  const needsHeading = chrome === 'full' || !!floorPlan;
  useEffect(() => {
    if (!engine || !needsHeading) return;
    let last = Number.NaN;
    return engine.onFrame(() => {
      const yaw = engine.getView().yaw;
      if (!(Math.abs(yaw - last) <= 0.5)) {
        last = yaw;
        setHeading(yaw);
      }
    });
  }, [engine, needsHeading]);

  // ------------------------------------------------------------------ scene display
  const variantFor = useCallback(
    (s: ViewerSceneDTO) =>
      engine ? selectVariant(s.variants, deviceProfile(engine.maxTextureSize, hd)) : undefined,
    [engine, hd],
  );

  /** Lowest-resolution variant, shown first while the sharp one loads. */
  const previewFor = useCallback(
    (s: ViewerSceneDTO) => {
      const low = s.variants[0];
      const main = variantFor(s);
      return low && main && low.width < main.width ? low : undefined;
    },
    [variantFor],
  );

  const variant = scene ? variantFor(scene) : undefined;
  const variantKey = scene && variant ? textureKey(scene.id, variant.width) : null;

  useEffect(() => {
    if (!engine || !scene || !variant || !variantKey) return;
    let cancelled = false;
    const isNewScene = shownSceneId.current !== scene.id;
    if (isNewScene) {
      shownSceneId.current = scene.id;
      const view = pendingView.current ?? scene.startView ?? { yaw: 0, pitch: 0, fov: DEFAULT_FOV };
      pendingView.current = null;
      engine.setView(view);
      setOpenInfo(null);
    }
    const preview = isNewScene ? previewFor(scene) : undefined;
    setImageState('loading');
    engine
      .showImage(
        variantKey,
        variant.url,
        isNewScene ? scene.placeholder : null,
        preview ? textureKey(scene.id, preview.width) : null,
      )
      .then(() => !cancelled && setImageState('ready'))
      .catch(() => !cancelled && setImageState('error'));
    if (isNewScene && arrival.current?.sceneId === scene.id) arrival.current.resolve();
    return () => {
      cancelled = true;
    };
    // variant.url intentionally excluded: signed URLs may rotate, the key identifies the image.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, scene?.id, variantKey, reloadKey]);

  // Preload the rooms this one leads to: low resolution first, then the size we would show.
  useEffect(() => {
    if (!engine || !scene || imageState === 'loading') return;
    const rank = { next: 0, back: 1, link: 2, info: 3 } as const;
    const targets = [...scene.hotspots]
      .filter((h) => h.kind !== 'info' && h.targetSceneId)
      .sort((a, b) => rank[a.kind] - rank[b.kind])
      .map((h) => scenes.find((s) => s.id === h.targetSceneId))
      .filter((s, i, all): s is ViewerSceneDTO => !!s && all.indexOf(s) === i)
      .slice(0, PRELOAD_LIMIT);
    void (async () => {
      for (const t of targets) {
        const low = previewFor(t);
        if (low) await engine.preload(textureKey(t.id, low.width), low.url);
      }
      for (const t of targets) {
        const main = variantFor(t);
        if (main) await engine.preload(textureKey(t.id, main.width), main.url);
      }
    })();
  }, [engine, scene, scenes, imageState, variantFor, previewFor]);

  // Stereo markers mirror the current scene's hotspots.
  useEffect(() => {
    engine?.setStereoMarkers(
      stereo && scene
        ? scene.hotspots.map((h) => ({ id: h.id, yaw: h.yaw, pitch: h.pitch, kind: h.kind }))
        : [],
    );
  }, [engine, stereo, scene]);

  // ------------------------------------------------------------------ walking
  const applyPose = useCallback((e: PanoramaEngine, pose: WalkPose) => {
    e.setView({ yaw: pose.yaw, pitch: pose.pitch, fov: pose.fov });
    if (overlayRef.current) overlayRef.current.style.opacity = String(pose.overlay);
  }, []);

  /** Resolves true once the target's first usable texture is decoded (false on error/timeout). */
  const waitForTarget = useCallback(
    (e: PanoramaEngine, target: ViewerSceneDTO): Promise<boolean> => {
      const main = variantFor(target);
      if (!main) return Promise.resolve(true);
      const loads = [e.ensureTexture(textureKey(target.id, main.width), main.url)];
      const low = previewFor(target);
      if (low) loads.push(e.ensureTexture(textureKey(target.id, low.width), low.url));
      return new Promise((resolve) => {
        let failed = 0;
        for (const p of loads) {
          p.then(
            () => resolve(true),
            () => ++failed === loads.length && resolve(false),
          );
        }
        setTimeout(() => resolve(false), WALK_LOAD_TIMEOUT_MS);
      });
    },
    [variantFor, previewFor],
  );

  /**
   * Walks to another scene. With `walkYaw` (an arrow's direction) the camera turns toward it,
   * zooms in and fades to black, then arrives facing the same way; without it, a plain fade.
   * Only one walk runs at a time; resolves false if the walk could not start.
   */
  const walkTo = useCallback(
    async (targetId: string, walkYaw?: number): Promise<boolean> => {
      const e = engineRef.current;
      const from = scene;
      const target = scenes.find((s) => s.id === targetId);
      if (!e || !from || !target || target.id === from.id || walkingRef.current) return false;
      walkingRef.current = true;
      setWalking(true);
      setOpenInfo(null);

      const start = e.getView();
      const directed = walkYaw !== undefined;
      const plain = reducedMotion || !directed;
      const ready = waitForTarget(e, target);
      const loadingTimer = setTimeout(() => mounted.current && setWalkLoading(true), 250);

      await animate(walkOutDuration(plain), (t) =>
        applyPose(e, walkOutPose(t, start, walkYaw ?? start.yaw, plain)),
      );
      await ready;
      clearTimeout(loadingTimer);
      if (!mounted.current) return false;
      setWalkLoading(false);

      const arrive: View = directed
        ? {
            yaw: arrivalYaw(walkYaw, from.northOffset, target.northOffset),
            pitch: 0,
            fov: start.fov,
          }
        : (target.startView ?? {
            // Keep the compass heading when the target has no explicit start view.
            yaw: normalizeYaw(start.yaw - from.northOffset + target.northOffset),
            pitch: 0,
            fov: start.fov,
          });
      pendingView.current = plain
        ? arrive
        : { yaw: arrive.yaw, pitch: WALK_PITCH, fov: zoomedFov(arrive.fov) };
      const shown = new Promise<void>((resolve) => {
        arrival.current = { sceneId: target.id, resolve };
        setTimeout(resolve, 1000);
      });
      if (controlledSceneId === undefined) setInternalSceneId(target.id);
      callbacks.current.onSceneChange?.(target.id);
      await shown;
      arrival.current = null;
      if (!mounted.current || !engineRef.current) return false;

      await animate(walkInDuration(plain), (t) =>
        applyPose(engineRef.current ?? e, walkInPose(t, arrive, plain)),
      );
      if (overlayRef.current) overlayRef.current.style.opacity = '0';
      walkingRef.current = false;
      if (mounted.current) setWalking(false);
      return true;
    },
    [scene, scenes, reducedMotion, waitForTarget, controlledSceneId, applyPose],
  );

  useImperativeHandle(
    ref,
    () => ({
      getView: () => engineRef.current?.getView() ?? null,
      setView: (v) => engineRef.current?.setView(v),
      unproject: (x, y) => engineRef.current?.unproject(x, y) ?? null,
      walkTo: (id, yaw) => void walkTo(id, yaw),
    }),
    [walkTo],
  );

  useEffect(() => {
    if (!engine) return;
    engine.setOptions({
      onGazeActivate: (markerId) => {
        const h = scene?.hotspots.find((x) => x.id === markerId);
        if (h && h.kind !== 'info' && h.targetSceneId) void walkTo(h.targetSceneId, h.yaw);
      },
    });
  }, [engine, scene, walkTo]);

  const activateHotspot = useCallback(
    (h: HotspotDTO) => {
      if (editable) {
        onHotspotSelect?.(h);
        return;
      }
      if (h.kind === 'info') setOpenInfo(h);
      else if (h.targetSceneId) void walkTo(h.targetSceneId, h.yaw);
    },
    [editable, onHotspotSelect, walkTo],
  );

  const sceneName = useCallback(
    (h: HotspotDTO) => scenes.find((s) => s.id === h.targetSceneId)?.name ?? 'next room',
    [scenes],
  );

  // ------------------------------------------------------------------ guided walk
  const canGuide = scenes.length > 1;

  const startGuided = useCallback(() => {
    if (!scene || !canGuide) return;
    setRotating(false);
    setGuided(true);
    // From the last room, start again at the beginning.
    if (!nextArrow(scene, scenes) && scenes[0] && scenes[0].id !== scene.id) {
      void walkTo(scenes[0].id);
    }
  }, [scene, scenes, canGuide, walkTo]);

  const stopGuided = useCallback(() => setGuided(false), []);

  // Dwell in each room, then follow its "next" arrow; stop after the last room.
  useEffect(() => {
    if (!guided || walking || !scene || imageState === 'loading') return;
    const timer = setTimeout(() => {
      if (!guidedRef.current) return;
      const arrow = nextArrow(scene, scenes);
      if (!arrow?.targetSceneId) {
        setGuided(false);
        return;
      }
      void walkTo(arrow.targetSceneId, arrow.yaw).then((ok) => {
        if (!ok) setGuided(false);
      });
    }, GUIDED_DWELL_MS);
    return () => clearTimeout(timer);
  }, [guided, walking, scene, scenes, imageState, walkTo]);

  // Any key press anywhere stops the guided walk.
  useEffect(() => {
    if (!guided) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.('[data-walk-button]')) return;
      setGuided(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [guided]);

  // ?autoplay=1: start once the first room is on screen.
  const autoplayed = useRef(false);
  useEffect(() => {
    if (!autoplay || autoplayed.current || !canGuide || imageState !== 'ready') return;
    autoplayed.current = true;
    startGuided();
  }, [autoplay, canGuide, imageState, startGuided]);

  // ------------------------------------------------------------------ controls
  useEffect(() => {
    const onChange = () => {
      const active = !!document.fullscreenElement;
      setFullscreen(active);
      if (!active) {
        setStereo(false);
        engineRef.current?.setStereo(false);
      }
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  async function toggleFullscreen(force?: boolean) {
    const root = rootRef.current;
    if (!root) return;
    const want = force ?? !(fullscreen || pseudoFullscreen);
    if (want) {
      if (root.requestFullscreen) {
        await root.requestFullscreen().catch(() => setPseudoFullscreen(true));
      } else {
        setPseudoFullscreen(true); // iPhone Safari has no element fullscreen
      }
    } else {
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
      setPseudoFullscreen(false);
    }
  }

  async function toggleGyro() {
    if (!engine) return;
    if (gyroOn) {
      engine.disableGyro();
      setGyroOn(false);
      return;
    }
    const ok = await engine.enableGyro();
    setGyroOn(ok);
    if (ok) setRotating(false);
  }

  async function toggleStereo() {
    if (!engine) return;
    const next = !stereo;
    setStereo(next);
    engine.setStereo(next);
    setOpenInfo(null);
    if (next) {
      setRotating(false);
      await toggleFullscreen(true);
      try {
        await (
          screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }
        ).lock?.('landscape');
      } catch {
        /* orientation lock is optional */
      }
      if (supportsGyroscope() && !gyroOn) await toggleGyro();
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!engine || (e.target as HTMLElement).closest('input,textarea,select')) return;
    const step = e.shiftKey ? 15 : 5;
    const actions: Record<string, () => void> = {
      ArrowLeft: () => engine.rotateBy(-step, 0),
      ArrowRight: () => engine.rotateBy(step, 0),
      ArrowUp: () => engine.rotateBy(0, step),
      ArrowDown: () => engine.rotateBy(0, -step),
      '+': () => engine.zoomBy(-5),
      '=': () => engine.zoomBy(-5),
      '-': () => engine.zoomBy(5),
      Escape: () => (openInfo ? setOpenInfo(null) : stereo && void toggleStereo()),
    };
    const action = actions[e.key];
    if (action) {
      e.preventDefault();
      setRotating(false);
      action();
    }
  }

  const canHd = !!scene && scene.variants.some((v) => v.width >= 8192);
  const showChrome = chrome !== 'none' && !stereo;
  const isFull = fullscreen || pseudoFullscreen;
  const stripVisible = showChrome && scenes.length > 1 && stripOpen;

  // ------------------------------------------------------------------ render
  return (
    <div
      ref={rootRef}
      className={`relative overflow-hidden bg-ink-950 text-white ${
        pseudoFullscreen ? 'fixed inset-0 z-50' : ''
      } ${className}`}
      role="region"
      aria-roledescription="360° viewer"
      aria-label={title ? `360° tour: ${title}` : '360° viewer'}
      aria-busy={walking || undefined}
      onPointerDownCapture={(e) => {
        // Any click or drag (except on the Walk through button itself) ends the guided walk.
        if (guidedRef.current && !(e.target as HTMLElement).closest('[data-walk-button]')) {
          stopGuided();
        }
      }}
    >
      <div
        ref={stageRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        className={`absolute inset-0 ${crosshair ? 'cursor-crosshair' : 'cursor-grab active:cursor-grabbing'}`}
        aria-label={
          scene
            ? `Panorama "${scene.name}". Drag or use arrow keys to look around, plus and minus to zoom.`
            : 'Empty panorama viewer'
        }
      />

      {engine && scene && !stereo && (
        <HotspotLayer
          engine={engine}
          hotspots={scene.hotspots}
          sceneName={sceneName}
          editable={editable}
          selectedId={selectedHotspotId ?? null}
          onActivate={activateHotspot}
          onMove={onHotspotMove}
        />
      )}

      {/* Walking transition: black fade driven frame by frame. */}
      <div
        ref={overlayRef}
        className="pointer-events-none absolute inset-0 bg-black"
        style={{ opacity: 0 }}
        aria-hidden="true"
      />
      {walkLoading && (
        <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/10 px-3 py-1 text-xs text-slate-200">
          Loading the next room…
        </div>
      )}
      <p className="sr-only" aria-live="polite">
        {scene ? `Now in ${scene.name}` : ''}
      </p>

      {stereo && (
        <div className="pointer-events-none absolute inset-0 grid grid-cols-2" aria-hidden="true">
          {[0, 1].map((i) => (
            <div key={i} className="grid place-items-center">
              <div className="h-4 w-4 rounded-full border-2 border-white/90 shadow" />
            </div>
          ))}
        </div>
      )}

      {/* Status overlays */}
      {engineState.status === 'error' && (
        <Overlay>
          <p className="max-w-sm text-center text-sm text-slate-300">{engineState.message}</p>
        </Overlay>
      )}
      {engineState.status !== 'error' && !scene && (
        <Overlay>{emptyState ?? <p className="text-sm text-slate-400">No scenes yet.</p>}</Overlay>
      )}
      {scene && !variant && engineState.status === 'ready' && (
        <Overlay>
          <p className="text-sm text-slate-300">This scene is still being prepared…</p>
        </Overlay>
      )}
      {imageState === 'error' && !walking && (
        <Overlay>
          <div className="flex flex-col items-center gap-3" data-viewer-ui>
            <p className="text-sm text-slate-300">The panorama image could not be loaded.</p>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setReloadKey((k) => k + 1)}
            >
              <RefreshIcon size={16} /> Try again
            </button>
          </div>
        </Overlay>
      )}
      {imageState === 'loading' && variant && !walking && (
        <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1 text-xs text-slate-200 backdrop-blur">
          Loading {variant.width >= 4096 ? 'high-resolution ' : ''}image…
        </div>
      )}

      {showChrome && title && chrome === 'full' && (
        <div className="pointer-events-none absolute left-0 right-0 top-0 bg-gradient-to-b from-black/60 to-transparent p-4">
          <h1 className="text-lg font-semibold drop-shadow">{title}</h1>
          {scene && <p className="text-sm text-slate-200/90">{scene.name}</p>}
        </div>
      )}

      {showChrome && chrome === 'full' && scene && (
        <div
          className="absolute right-3 top-3 grid h-12 w-12 place-items-center rounded-full bg-black/55 backdrop-blur"
          role="img"
          aria-label={`Compass: facing ${Math.round(normalizeYaw(heading - scene.northOffset) + 360) % 360} degrees from north`}
        >
          <div
            className="relative h-9 w-9"
            style={{ transform: `rotate(${-(heading - scene.northOffset)}deg)` }}
          >
            <span className="absolute left-1/2 top-0 -translate-x-1/2 text-[10px] font-bold text-red-400">
              N
            </span>
            <span className="absolute left-1/2 top-3 h-3 w-0.5 -translate-x-1/2 rounded bg-red-400" />
          </div>
        </div>
      )}

      {showChrome && floorPlan && scene && (
        <MiniMap
          floorPlan={floorPlan}
          scenes={scenes}
          currentId={scene.id}
          heading={heading}
          className={chrome === 'full' && title ? 'top-20' : 'top-3'}
          onSelect={(id, walkYaw) => void walkTo(id, walkYaw)}
        />
      )}

      {/* Guided walk */}
      {showChrome && canGuide && (
        <button
          type="button"
          data-viewer-ui
          data-walk-button
          aria-pressed={guided}
          onClick={() => (guided ? stopGuided() : startGuided())}
          className={`absolute left-3 flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold shadow-lg backdrop-blur transition ${
            stripVisible ? 'bottom-28' : 'bottom-3'
          } ${
            guided
              ? 'border-white/80 bg-white text-ink-950 hover:bg-slate-200'
              : 'border-white/20 bg-black/55 text-white hover:bg-black/75'
          }`}
        >
          {guided ? <StopIcon size={16} /> : <PlayIcon size={16} />}
          {guided ? 'Stop' : 'Walk through'}
        </button>
      )}

      {/* Controls */}
      {chrome !== 'none' && (
        <div
          data-viewer-ui
          className={`absolute right-3 flex flex-col gap-2 ${stripVisible ? 'bottom-28' : 'bottom-3'}`}
        >
          {stereo ? (
            <button
              type="button"
              className="viewer-btn"
              onClick={toggleStereo}
              aria-label="Exit VR mode"
            >
              <CloseIcon />
            </button>
          ) : (
            <>
              <button
                type="button"
                className="viewer-btn"
                onClick={() => engine?.zoomBy(-10)}
                aria-label="Zoom in"
              >
                <PlusIcon />
              </button>
              <button
                type="button"
                className="viewer-btn"
                onClick={() => engine?.zoomBy(10)}
                aria-label="Zoom out"
              >
                <MinusIcon />
              </button>
              {!reducedMotion && (
                <button
                  type="button"
                  className="viewer-btn"
                  aria-pressed={rotating}
                  onClick={() => setRotating((r) => !r)}
                  aria-label={rotating ? 'Stop auto-rotation' : 'Start auto-rotation'}
                >
                  <RotateIcon />
                </button>
              )}
              {canHd && (
                <button
                  type="button"
                  className="viewer-btn"
                  aria-pressed={hd}
                  onClick={() => setHd((v) => !v)}
                  aria-label={hd ? 'Use standard resolution' : 'Load highest resolution'}
                >
                  <HdIcon />
                </button>
              )}
              {supportsGyroscope() && (
                <button
                  type="button"
                  className="viewer-btn"
                  aria-pressed={gyroOn}
                  onClick={toggleGyro}
                  aria-label={
                    gyroOn ? 'Disable motion control' : 'Look around by moving your device'
                  }
                >
                  <PhoneTiltIcon />
                </button>
              )}
              <button
                type="button"
                className="viewer-btn"
                onClick={toggleStereo}
                aria-label="VR headset mode"
              >
                <GogglesIcon />
              </button>
              <button
                type="button"
                className="viewer-btn"
                onClick={() => void toggleFullscreen()}
                aria-label={isFull ? 'Exit fullscreen' : 'Fullscreen'}
              >
                {isFull ? <ShrinkIcon /> : <ExpandIcon />}
              </button>
            </>
          )}
        </div>
      )}

      {/* Scene strip */}
      {showChrome && scenes.length > 1 && (
        <nav
          data-viewer-ui
          aria-label="Scenes"
          className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/75 to-transparent pt-6"
        >
          <button
            type="button"
            className="absolute right-16 top-0 rounded-t-md bg-black/50 px-2 text-slate-200"
            onClick={() => setStripOpen((o) => !o)}
            aria-expanded={stripOpen}
            aria-label={stripOpen ? 'Hide scene list' : 'Show scene list'}
          >
            {stripOpen ? <ChevronDownIcon size={16} /> : <ChevronUpIcon size={16} />}
          </button>
          {stripOpen && (
            <ul className="flex gap-2 overflow-x-auto px-3 pb-3">
              {scenes.map((s) => (
                <li key={s.id} className="shrink-0">
                  <button
                    type="button"
                    onClick={() => void walkTo(s.id)}
                    aria-current={s.id === scene?.id ? 'true' : undefined}
                    aria-label={`Go to ${s.name}`}
                    className={`group block w-28 overflow-hidden rounded-lg border-2 text-left transition ${
                      s.id === scene?.id
                        ? 'border-brand-400'
                        : 'border-transparent hover:border-white/50'
                    }`}
                  >
                    {s.thumbUrl ? (
                      <img
                        src={s.thumbUrl}
                        alt=""
                        className="h-14 w-full object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <div className="h-14 w-full bg-ink-700" />
                    )}
                    <span className="block truncate bg-black/60 px-2 py-1 text-xs">{s.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </nav>
      )}

      {/* Info hotspot popup */}
      {openInfo && (
        <div
          data-viewer-ui
          role="dialog"
          aria-modal="false"
          aria-labelledby="hotspot-info-title"
          className="absolute inset-x-3 bottom-3 z-10 mx-auto max-w-md rounded-2xl border border-white/10 bg-ink-900/95 p-4 shadow-2xl backdrop-blur sm:bottom-auto sm:left-auto sm:right-20 sm:top-20 sm:mx-0 sm:w-80"
          onKeyDown={(e) => e.key === 'Escape' && setOpenInfo(null)}
        >
          <div className="mb-2 flex items-start justify-between gap-3">
            <h2 id="hotspot-info-title" className="text-base font-semibold">
              {openInfo.title}
            </h2>
            <button
              type="button"
              className="rounded p-1 text-slate-400 hover:text-white"
              onClick={() => setOpenInfo(null)}
              aria-label="Close"
              autoFocus
            >
              <CloseIcon size={18} />
            </button>
          </div>
          {openInfo.imageUrl && (
            <img
              src={openInfo.imageUrl}
              alt=""
              referrerPolicy="no-referrer"
              loading="lazy"
              className="mb-3 max-h-48 w-full rounded-lg object-cover"
            />
          )}
          {openInfo.text && (
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-300">
              {openInfo.text}
            </p>
          )}
        </div>
      )}

      {children}
    </div>
  );
});

function Overlay({ children }: { children: ReactNode }) {
  return (
    <div className="pointer-events-none absolute inset-0 grid place-items-center p-6">
      <div className="pointer-events-auto">{children}</div>
    </div>
  );
}
