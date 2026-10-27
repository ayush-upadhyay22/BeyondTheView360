import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useIsMutating, useMutationState } from '@tanstack/react-query';
import {
  MAX_FOV,
  MAX_HOTSPOTS_PER_SCENE,
  MIN_FOV,
  clamp,
  normalizeYaw,
  round,
  type HotspotDTO,
  type SceneDTO,
  type View,
} from '@btv/shared';
import { AppHeader, Logo } from '../components/Layout';
import { Dialog } from '../components/Dialog';
import { SharePanel } from '../components/SharePanel';
import { ErrorState, FullPageSpinner, Spinner } from '../components/feedback';
import { CompassIcon, CrosshairIcon, EyeIcon, InfoIcon, LinkIcon } from '../components/icons';
import { ApiError, errorMessage } from '../lib/api';
import { useMe } from '../lib/auth';
import {
  isBusy,
  useCreateHotspot,
  useDeleteHotspot,
  useDeleteScene,
  useReorderScenes,
  useRetryScene,
  useTour,
  useUpdateHotspot,
  useUpdateScene,
  useUpdateTour,
} from '../lib/queries';
import { shareUrl } from '../lib/share';
import { TourPlayer, type TourPlayerHandle } from '../viewer/TourPlayer';
import { Uploader } from '../editor/Uploader';
import { SceneList } from '../editor/SceneList';
import { HotspotPanel, TourSettings } from '../editor/Inspector';
import { ViewStats } from '../editor/ViewStats';
import { VisibilityBadge } from './Dashboard';

type AddMode = 'link' | 'info' | null;

function SaveStatus({ tourId }: { tourId: string }) {
  const saving = useIsMutating({ mutationKey: ['tour-edit', tourId] }) > 0;
  const states = useMutationState({
    filters: { mutationKey: ['tour-edit', tourId] },
    select: (m) => ({ status: m.state.status, error: m.state.error, at: m.state.submittedAt }),
  });
  const last = states.reduce<(typeof states)[number] | undefined>(
    (a, b) => (!a || b.at >= a.at ? b : a),
    undefined,
  );
  if (saving) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-slate-400" aria-live="polite">
        <Spinner size={12} label="Saving" /> Saving…
      </span>
    );
  }
  if (last?.status === 'error') {
    return (
      <span className="text-xs text-red-300" role="alert">
        Not saved: {errorMessage(last.error)}
      </span>
    );
  }
  return (
    <span className="text-xs text-slate-500" aria-live="polite">
      {last ? 'All changes saved' : ''}
    </span>
  );
}

function ToolButton({
  active,
  disabled,
  onClick,
  children,
  title,
}: {
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={`btn px-3 py-1.5 text-xs ${
        active
          ? 'bg-brand-500 text-white'
          : 'border border-ink-600 bg-ink-800 text-slate-200 hover:bg-ink-700'
      }`}
    >
      {children}
    </button>
  );
}

export default function TourEditor() {
  const { tourId = '' } = useParams();
  const me = useMe();
  const tourQuery = useTour(tourId);
  const updateTour = useUpdateTour(tourId);
  const updateScene = useUpdateScene(tourId);
  const deleteScene = useDeleteScene(tourId);
  const retryScene = useRetryScene(tourId);
  const reorder = useReorderScenes(tourId);
  const createHotspot = useCreateHotspot(tourId);
  const updateHotspot = useUpdateHotspot(tourId);
  const deleteHotspot = useDeleteHotspot(tourId);

  const playerRef = useRef<TourPlayerHandle>(null);
  const [sceneId, setSceneId] = useState<string | null>(null);
  const [selectedHotspotId, setSelectedHotspotId] = useState<string | null>(null);
  const [mode, setMode] = useState<AddMode>(null);
  const [sharing, setSharing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const tour = tourQuery.data;
  const scenes = useMemo(
    () => [...(tour?.scenes ?? [])].sort((a, b) => a.position - b.position),
    [tour?.scenes],
  );
  const ready = useMemo(() => scenes.filter((s) => s.status === 'ready'), [scenes]);
  const current: SceneDTO | null =
    scenes.find((s) => s.id === sceneId) ??
    ready.find((s) => s.id === tour?.startSceneId) ??
    ready[0] ??
    scenes[0] ??
    null;
  const currentReady = current?.status === 'ready';
  const selectedHotspot = currentReady
    ? (current.hotspots.find((h) => h.id === selectedHotspotId) ?? null)
    : null;
  const linkTarget = ready.find((s) => s.id !== current?.id);
  const hotspotLimit = (current?.hotspots.length ?? 0) >= MAX_HOTSPOTS_PER_SCENE;

  useEffect(() => {
    if (!mode) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMode(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  const selectScene = useCallback((id: string) => {
    setSceneId(id);
    setSelectedHotspotId(null);
    setMode(null);
  }, []);

  const currentView = useCallback((): View | null => {
    const v = playerRef.current?.getView();
    if (!v) return null;
    return {
      yaw: round(normalizeYaw(v.yaw), 2),
      pitch: round(clamp(v.pitch, -90, 90), 2),
      fov: round(clamp(v.fov, MIN_FOV, MAX_FOV), 1),
    };
  }, []);

  const onViewerClick = useCallback(
    (pos: { yaw: number; pitch: number }) => {
      if (!mode) {
        setSelectedHotspotId(null);
        return;
      }
      if (!current || !currentReady) return;
      const at = {
        yaw: round(normalizeYaw(pos.yaw), 2),
        pitch: round(clamp(pos.pitch, -90, 90), 2),
      };
      const select = { onSuccess: (h: HotspotDTO) => setSelectedHotspotId(h.id) };
      if (mode === 'link' && linkTarget) {
        createHotspot.mutate(
          { sceneId: current.id, type: 'link', ...at, targetSceneId: linkTarget.id, title: '' },
          select,
        );
      } else if (mode === 'info') {
        createHotspot.mutate(
          {
            sceneId: current.id,
            type: 'info',
            ...at,
            title: 'Point of interest',
            text: '',
            imageUrl: null,
          },
          select,
        );
      }
      setMode(null);
    },
    [mode, current, currentReady, linkTarget, createHotspot],
  );

  const onHotspotMove = useCallback(
    (h: HotspotDTO, pos: { yaw: number; pitch: number }) =>
      updateHotspot.mutate({
        id: h.id,
        yaw: round(normalizeYaw(pos.yaw), 2),
        pitch: round(clamp(pos.pitch, -90, 90), 2),
      }),
    [updateHotspot],
  );

  if (tourQuery.isPending || me.isPending) return <FullPageSpinner />;
  if (tourQuery.isError || !tour) {
    const missing = tourQuery.error instanceof ApiError && tourQuery.error.status === 404;
    return (
      <div className="flex min-h-full flex-col">
        <AppHeader />
        <div className="p-8">
          <ErrorState
            title={missing ? 'Tour not found' : 'Could not load tour'}
            message={
              missing
                ? 'It may have been deleted, or it belongs to another account.'
                : errorMessage(tourQuery.error)
            }
            action={
              <Link to="/app" className="btn-secondary">
                Back to my tours
              </Link>
            }
          />
        </div>
      </div>
    );
  }

  const limits = me.data?.limits;
  const remainingScenes = Math.max(0, (limits?.maxScenesPerTour ?? 0) - scenes.length);

  function confirmDeleteScene(s: SceneDTO) {
    if (!window.confirm(`Delete scene “${s.name}”? Hotspots linking to it are removed too.`)) {
      return;
    }
    if (s.id === current?.id) setSceneId(null);
    setSelectedHotspotId(null);
    deleteScene.mutate(s.id);
  }

  function saveSceneStart() {
    const view = currentView();
    if (!view || !current) return;
    updateScene.mutate({ id: current.id, startView: view });
    setToast('Scene start view saved');
  }

  function saveNorth() {
    const view = currentView();
    if (!view || !current) return;
    updateScene.mutate({ id: current.id, northOffset: view.yaw });
    setToast('North set to the current direction');
  }

  function saveTourStart() {
    const view = currentView();
    if (!view || !current) return;
    updateTour.mutate({ startSceneId: current.id, startView: view });
    setToast('Tour will open here');
  }

  const processing = scenes.filter(isBusy).length;

  return (
    <div className="flex min-h-full flex-col lg:h-[100dvh]">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-ink-700 bg-ink-950 px-4">
        <Logo compact />
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-sm">
          <Link to="/app" className="shrink-0 text-slate-400 hover:text-white">
            My tours
          </Link>
          <span className="text-slate-600" aria-hidden="true">
            /
          </span>
          <h1 className="truncate font-medium">{tour.title}</h1>
        </nav>
        <VisibilityBadge visibility={tour.visibility} />
        <div className="hidden min-w-0 md:block">
          <SaveStatus tourId={tourId} />
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <a
            href={shareUrl(tour.shareId)}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-ghost hidden sm:inline-flex"
          >
            <EyeIcon size={16} /> Preview
          </a>
          <button type="button" className="btn-secondary" onClick={() => setSharing(true)}>
            <LinkIcon size={16} /> Share
          </button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 lg:grid-cols-[16rem_minmax(0,1fr)_17rem] xl:grid-cols-[19rem_minmax(0,1fr)_20rem]">
        {/* Scenes */}
        <aside className="space-y-4 overflow-y-auto border-ink-700 p-4 lg:border-r">
          <Uploader
            tourId={tourId}
            maxBytes={limits?.maxUploadBytes ?? 0}
            remaining={remainingScenes}
          />
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold">Scenes</h2>
            <span className="text-xs text-slate-500">
              {scenes.length} / {limits?.maxScenesPerTour ?? '–'}
              {processing > 0 && ` · ${processing} processing`}
            </span>
          </div>
          <SceneList
            scenes={scenes}
            currentId={current?.id ?? null}
            startSceneId={tour.startSceneId ?? ready[0]?.id ?? null}
            onSelect={selectScene}
            onRename={(id, name) => updateScene.mutate({ id, name })}
            onReorder={(ids) => reorder.mutate(ids)}
            onDelete={confirmDeleteScene}
            onRetry={(id) => retryScene.mutate(id)}
          />
        </aside>

        {/* Viewer */}
        <section className="flex min-h-[60vh] flex-col" aria-label="Scene editor">
          <div className="flex flex-wrap items-center gap-2 border-b border-ink-700 px-3 py-2">
            <ToolButton
              active={mode === 'link'}
              disabled={!currentReady || !linkTarget || hotspotLimit}
              title={
                linkTarget
                  ? 'Place a hotspot that moves to another scene'
                  : 'Add a second scene first'
              }
              onClick={() => setMode((m) => (m === 'link' ? null : 'link'))}
            >
              <LinkIcon size={14} /> Add link
            </ToolButton>
            <ToolButton
              active={mode === 'info'}
              disabled={!currentReady || hotspotLimit}
              title="Place an information point"
              onClick={() => setMode((m) => (m === 'info' ? null : 'info'))}
            >
              <InfoIcon size={14} /> Add info
            </ToolButton>
            <span className="mx-1 hidden h-5 w-px bg-ink-600 sm:block" />
            <ToolButton
              disabled={!currentReady}
              onClick={saveSceneStart}
              title="Visitors arriving in this scene look this way"
            >
              <CrosshairIcon size={14} /> Scene starts here
            </ToolButton>
            <ToolButton
              disabled={!currentReady}
              onClick={saveNorth}
              title="Mark the current direction as north (used for the compass and to keep heading between scenes)"
            >
              <CompassIcon size={14} /> North is here
            </ToolButton>
            <ToolButton
              disabled={!currentReady}
              onClick={saveTourStart}
              title="The tour opens in this scene, facing this way"
            >
              Tour starts here
            </ToolButton>
            <span className="ml-auto text-xs text-slate-400" aria-live="polite">
              {mode
                ? 'Click in the panorama to place it · Esc to cancel'
                : (toast ?? 'Drag to look around · click a hotspot to edit')}
            </span>
          </div>

          <div className="relative min-h-[50vh] flex-1">
            <div className="absolute inset-0">
              <TourPlayer
                ref={playerRef}
                className="h-full w-full"
                scenes={ready}
                sceneId={currentReady ? current.id : (ready[0]?.id ?? null)}
                onSceneChange={selectScene}
                chrome="minimal"
                autorotate={false}
                editable
                crosshair={!!mode}
                selectedHotspotId={selectedHotspotId}
                onHotspotSelect={(h) => {
                  setSelectedHotspotId(h.id);
                  setMode(null);
                }}
                onHotspotMove={onHotspotMove}
                onViewerClick={onViewerClick}
                emptyState={
                  <p className="max-w-xs text-center text-sm text-slate-400">
                    Upload a 360° photo on the left. It appears here as soon as it is processed.
                  </p>
                }
              />
            </div>
            {current && !currentReady && (
              <div className="absolute inset-0 grid place-items-center bg-ink-950/90 p-6 text-center">
                <div className="max-w-xs">
                  {current.status === 'failed' ? (
                    <>
                      <p className="font-medium text-red-200">This photo could not be processed</p>
                      <p className="mt-1 text-sm text-red-200/80">{current.error}</p>
                    </>
                  ) : (
                    <>
                      <Spinner size={28} />
                      <p className="mt-3 font-medium">Preparing “{current.name}”…</p>
                      <p className="mt-1 text-sm text-slate-400">
                        {current.status === 'processing'
                          ? `Creating resolutions · ${Math.round(current.progress)}%`
                          : 'Waiting in the queue'}
                      </p>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </section>

        {/* Inspector */}
        <aside className="space-y-8 overflow-y-auto border-ink-700 p-4 lg:border-l">
          {selectedHotspot ? (
            <HotspotPanel
              key={selectedHotspot.id}
              hotspot={selectedHotspot}
              scenes={ready}
              onChange={(input) => updateHotspot.mutate({ id: selectedHotspot.id, ...input })}
              onDelete={() => {
                deleteHotspot.mutate(selectedHotspot.id);
                setSelectedHotspotId(null);
              }}
              onClose={() => setSelectedHotspotId(null)}
              onLookAt={() =>
                playerRef.current?.setView({
                  yaw: selectedHotspot.yaw,
                  pitch: selectedHotspot.pitch,
                })
              }
            />
          ) : (
            current && (
              <section aria-labelledby="scene-heading" className="space-y-2">
                <h2 id="scene-heading" className="font-semibold">
                  {current.name}
                </h2>
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-slate-400">
                  <dt>Resolution</dt>
                  <dd className="text-slate-200">
                    {current.width ? `${current.width} × ${current.height}` : '—'}
                  </dd>
                  <dt>Start view</dt>
                  <dd className="text-slate-200">
                    {current.startView ? `${current.startView.yaw.toFixed(0)}°` : 'Default'}
                  </dd>
                  <dt>North</dt>
                  <dd className="text-slate-200">{current.northOffset.toFixed(0)}°</dd>
                </dl>
                {current.hotspots.length > 0 && (
                  <ul className="space-y-1 pt-2" aria-label="Hotspots in this scene">
                    {current.hotspots.map((h) => (
                      <li key={h.id}>
                        <button
                          type="button"
                          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-ink-800"
                          onClick={() => {
                            setSelectedHotspotId(h.id);
                            playerRef.current?.setView({ yaw: h.yaw, pitch: h.pitch });
                          }}
                        >
                          {h.type === 'link' ? (
                            <LinkIcon size={14} className="text-brand-300" />
                          ) : (
                            <InfoIcon size={14} className="text-ember-300" />
                          )}
                          <span className="truncate">
                            {h.title ||
                              `→ ${scenes.find((s) => s.id === h.targetSceneId)?.name ?? 'scene'}`}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )
          )}
          <TourSettings
            tour={tour}
            readyScenes={ready}
            onChange={(input) => updateTour.mutate(input)}
          />
          <ViewStats tourId={tourId} />
        </aside>
      </div>

      <Dialog open={sharing} onClose={() => setSharing(false)} title="Share tour" wide>
        <SharePanel shareId={tour.shareId} title={tour.title} visibility={tour.visibility} />
      </Dialog>
    </div>
  );
}
