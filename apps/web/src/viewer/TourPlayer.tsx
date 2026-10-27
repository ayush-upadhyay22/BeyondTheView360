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
  DEFAULT_FOV,
  normalizeYaw,
  selectVariant,
  type HotspotDTO,
  type View,
  type ViewerSceneDTO,
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
  PlusIcon,
  RefreshIcon,
  RotateIcon,
  ShrinkIcon,
} from '../components/icons';
import { PanoramaEngine, WebGLUnavailableError } from './PanoramaEngine';
import { HotspotLayer } from './HotspotLayer';
import { deviceProfile, prefersReducedMotion, supportsGyroscope } from './device';

export interface TourPlayerHandle {
  getView: () => View | null;
  setView: (view: Partial<View>) => void;
}

export interface TourPlayerProps {
  scenes: ViewerSceneDTO[];
  startSceneId?: string | null;
  /** Initial view for the first scene shown (tour start view). */
  startView?: View | null;
  /** Controlled current scene (editor). */
  sceneId?: string | null;
  onSceneChange?: (sceneId: string) => void;
  /** "full" = public page, "minimal" = embed / editor preview. */
  chrome?: 'full' | 'minimal' | 'none';
  title?: string;
  autorotate?: boolean;
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
  const engineRef = useRef<PanoramaEngine | null>(null);
  const [engine, setEngine] = useState<PanoramaEngine | null>(null);
  const [engineState, setEngineState] = useState<EngineState>({ status: 'starting' });
  const reducedMotion = useMemo(prefersReducedMotion, []);

  const [internalSceneId, setInternalSceneId] = useState<string | null>(
    () => startSceneId ?? scenes[0]?.id ?? null,
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
  const [fading, setFading] = useState(false);
  const [heading, setHeading] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);

  const pendingView = useRef<Partial<View> | null>(startView ?? null);
  const shownSceneId = useRef<string | null>(null);
  const callbacks = useRef({ onViewerClick, onViewChange });
  callbacks.current = { onViewerClick, onViewChange };

  useImperativeHandle(
    ref,
    () => ({
      getView: () => engineRef.current?.getView() ?? null,
      setView: (v) => engineRef.current?.setView(v),
    }),
    [],
  );

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
        onInteract: () => setRotating(false),
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

  useEffect(() => {
    engine?.setAutorotate(rotating);
  }, [engine, rotating]);

  // Heading for the compass, sampled each frame.
  useEffect(() => {
    if (!engine || chrome !== 'full') return;
    let last = 0;
    return engine.onFrame(() => {
      const yaw = engine.getView().yaw;
      if (Math.abs(yaw - last) > 0.5) {
        last = yaw;
        setHeading(yaw);
      }
    });
  }, [engine, chrome]);

  // ------------------------------------------------------------------ scene display
  const variantFor = useCallback(
    (s: ViewerSceneDTO) =>
      engine ? selectVariant(s.variants, deviceProfile(engine.maxTextureSize, hd)) : undefined,
    [engine, hd],
  );

  const variant = scene ? variantFor(scene) : undefined;
  const variantKey = scene && variant ? `${scene.id}:${variant.width}` : null;

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
    setImageState('loading');
    engine
      .showImage(variantKey, variant.url, isNewScene ? scene.placeholder : null)
      .then(() => !cancelled && setImageState('ready'))
      .catch(() => !cancelled && setImageState('error'));
    requestAnimationFrame(() => setFading(false));
    return () => {
      cancelled = true;
    };
    // variant.url intentionally excluded: signed URLs may rotate, the key identifies the image.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, scene?.id, variantKey, reloadKey]);

  // Preload the scenes this one links to.
  useEffect(() => {
    if (!engine || !scene || imageState !== 'ready') return;
    for (const h of scene.hotspots) {
      if (h.type !== 'link') continue;
      const target = scenes.find((s) => s.id === h.targetSceneId);
      const v = target && variantFor(target);
      if (target && v) engine.preload(`${target.id}:${v.width}`, v.url);
    }
  }, [engine, scene, scenes, imageState, variantFor]);

  // Stereo markers mirror the current scene's hotspots.
  useEffect(() => {
    engine?.setStereoMarkers(
      stereo && scene
        ? scene.hotspots.map((h) => ({ id: h.id, yaw: h.yaw, pitch: h.pitch, kind: h.type }))
        : [],
    );
  }, [engine, stereo, scene]);

  // ------------------------------------------------------------------ navigation
  const goTo = useCallback(
    (targetId: string) => {
      const target = scenes.find((s) => s.id === targetId);
      if (!target || !engine || target.id === scene?.id) return;
      const current = engine.getView();
      // Keep the compass heading when the target has no explicit start view.
      pendingView.current = target.startView ?? {
        yaw: normalizeYaw(current.yaw - (scene?.northOffset ?? 0) + target.northOffset),
        pitch: 0,
        fov: current.fov,
      };
      const swap = () => {
        if (controlledSceneId === undefined) setInternalSceneId(target.id);
        onSceneChange?.(target.id);
      };
      if (reducedMotion) {
        swap();
      } else {
        setFading(true);
        setTimeout(swap, 160);
      }
    },
    [scenes, engine, scene, controlledSceneId, onSceneChange, reducedMotion],
  );

  useEffect(() => {
    if (!engine) return;
    engine.setOptions({
      onGazeActivate: (markerId) => {
        const h = scene?.hotspots.find((x) => x.id === markerId);
        if (h?.type === 'link' && h.targetSceneId) goTo(h.targetSceneId);
      },
    });
  }, [engine, scene, goTo]);

  const activateHotspot = useCallback(
    (h: HotspotDTO) => {
      if (editable) {
        onHotspotSelect?.(h);
        return;
      }
      if (h.type === 'link' && h.targetSceneId) goTo(h.targetSceneId);
      else if (h.type === 'info') setOpenInfo(h);
    },
    [editable, onHotspotSelect, goTo],
  );

  const sceneName = useCallback(
    (h: HotspotDTO) => scenes.find((s) => s.id === h.targetSceneId)?.name ?? 'Next scene',
    [scenes],
  );

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

      {/* Fade between scenes */}
      <div
        className={`pointer-events-none absolute inset-0 bg-ink-950 transition-opacity duration-300 ${
          fading ? 'opacity-100' : 'opacity-0'
        }`}
      />

      {engine && scene && !stereo && (
        <HotspotLayer
          engine={engine}
          hotspots={scene.hotspots}
          labelFor={sceneName}
          editable={editable}
          selectedId={selectedHotspotId ?? null}
          onActivate={activateHotspot}
          onMove={onHotspotMove}
        />
      )}

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
      {imageState === 'error' && (
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
      {imageState === 'loading' && variant && (
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

      {/* Controls */}
      {chrome !== 'none' && (
        <div
          data-viewer-ui
          className={`absolute right-3 flex flex-col gap-2 ${
            showChrome && scenes.length > 1 && stripOpen ? 'bottom-28' : 'bottom-3'
          }`}
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
                    onClick={() => goTo(s.id)}
                    aria-current={s.id === scene?.id ? 'true' : undefined}
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
