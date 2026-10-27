import { useRef, useState } from 'react';
import type { SceneDTO, TourDTO } from '@btv/shared';
import { CloseIcon, MapIcon, UploadIcon } from '../components/icons';
import { errorMessage } from '../lib/api';
import {
  useAutoLinkNearby,
  useRemoveFloorPlan,
  useSetFloorPlan,
  useUpdateScene,
} from '../lib/queries';
import { Spinner } from '../components/feedback';

const PIN_DRAG = 'application/x-btv-plan-pin';

function pinFromEvent(e: { clientX: number; clientY: number }, el: HTMLElement) {
  const r = el.getBoundingClientRect();
  const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
  return { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 };
}

export function FloorPlanEditor({
  tour,
  onDone,
}: {
  tour: TourDTO;
  onDone: (msg: string) => void;
}) {
  const setPlan = useSetFloorPlan(tour.id);
  const removePlan = useRemoveFloorPlan(tour.id);
  const autoLink = useAutoLinkNearby(tour.id);
  const updateScene = useUpdateScene(tour.id);
  const fileRef = useRef<HTMLInputElement>(null);
  const mapRef = useRef<HTMLDivElement>(null);
  const [placing, setPlacing] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  const ready = tour.scenes.filter((s) => s.status === 'ready');
  const pinned = ready.filter((s) => s.mapX !== null && s.mapY !== null);
  const unpinned = ready.filter((s) => s.mapX === null || s.mapY === null);

  function onFile(file: File | undefined) {
    if (!file) return;
    setPlan.mutate(file, {
      onSuccess: () => onDone('Floor plan uploaded'),
    });
  }

  function savePin(scene: SceneDTO, x: number, y: number) {
    updateScene.mutate({ id: scene.id, mapX: x, mapY: y });
  }

  function onMapClick(e: React.MouseEvent<HTMLDivElement>) {
    if (!placing || !mapRef.current) return;
    const scene = ready.find((s) => s.id === placing);
    if (!scene) return;
    const pos = pinFromEvent(e, mapRef.current);
    savePin(scene, pos.x, pos.y);
    setPlacing(null);
  }

  return (
    <div className="space-y-4 text-sm">
      <p className="text-slate-400">
        Upload a plan of the space, then drag each room onto it. The viewer shows a mini-map;
        “Auto-link nearby rooms” aims extra arrows using the pin positions.
      </p>

      {!tour.floorPlan ? (
        <div className="rounded-xl border border-dashed border-ink-600 bg-ink-800/40 p-6 text-center">
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="sr-only"
            onChange={(e) => onFile(e.target.files?.[0])}
          />
          <button
            type="button"
            className="btn-primary mx-auto"
            disabled={setPlan.isPending}
            onClick={() => fileRef.current?.click()}
          >
            {setPlan.isPending ? <Spinner size={16} /> : <UploadIcon size={16} />}
            Upload floor plan
          </button>
          <p className="mt-2 text-xs text-slate-500">JPEG, PNG or WebP, up to 5 MB.</p>
          {setPlan.isError && (
            <p className="mt-2 text-xs text-red-300" role="alert">
              {errorMessage(setPlan.error)}
            </p>
          )}
        </div>
      ) : (
        <>
          <div
            ref={mapRef}
            className={`relative overflow-hidden rounded-xl border border-ink-600 bg-white ${
              placing ? 'cursor-crosshair' : ''
            }`}
            style={{ aspectRatio: `${tour.floorPlan.width} / ${tour.floorPlan.height}` }}
            onClick={onMapClick}
            onDragOver={(e) => {
              if (![PIN_DRAG, 'text/plain'].some((t) => e.dataTransfer.types.includes(t))) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
            }}
            onDrop={(e) => {
              const id = e.dataTransfer.getData(PIN_DRAG) || e.dataTransfer.getData('text/plain');
              const scene = ready.find((s) => s.id === id);
              if (!scene || !mapRef.current) return;
              e.preventDefault();
              const pos = pinFromEvent(e, mapRef.current);
              savePin(scene, pos.x, pos.y);
              setPlacing(null);
            }}
          >
            <img
              src={tour.floorPlan.url}
              alt="Floor plan"
              className="absolute inset-0 h-full w-full object-contain"
              draggable={false}
            />
            {pinned.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`absolute z-[1] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow ${
                  dragId === s.id ? 'h-5 w-5 bg-brand-300' : 'h-4 w-4 bg-brand-500'
                }`}
                style={{ left: `${s.mapX! * 100}%`, top: `${s.mapY! * 100}%` }}
                title={`${s.name} — drag to move`}
                aria-label={`Move pin for ${s.name}`}
                draggable
                onClick={(e) => e.stopPropagation()}
                onDragStart={(e) => {
                  setDragId(s.id);
                  e.dataTransfer.setData(PIN_DRAG, s.id);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onDragEnd={() => setDragId(null)}
              />
            ))}
          </div>
          <ul className="flex flex-wrap gap-2" aria-label="Rooms on the plan">
            {pinned.map((s) => (
              <li
                key={s.id}
                className="flex items-center gap-1 rounded-full bg-ink-800 px-2 py-1 text-xs"
              >
                <span className="h-2 w-2 rounded-full bg-brand-400" />
                {s.name}
                <button
                  type="button"
                  className="rounded p-0.5 text-slate-500 hover:text-white"
                  aria-label={`Remove pin for ${s.name}`}
                  onClick={() => updateScene.mutate({ id: s.id, mapX: null, mapY: null })}
                >
                  <CloseIcon size={12} />
                </button>
              </li>
            ))}
          </ul>
          {unpinned.length > 0 && (
            <div>
              <p className="mb-1 text-xs text-slate-400">
                {placing
                  ? 'Click the plan to place the pin'
                  : 'Drag a room onto the plan, or click one then click the plan'}
              </p>
              <ul className="flex flex-wrap gap-2">
                {unpinned.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData(PIN_DRAG, s.id);
                        e.dataTransfer.effectAllowed = 'move';
                      }}
                      onClick={() => setPlacing((id) => (id === s.id ? null : s.id))}
                      className={`rounded-full border px-2.5 py-1 text-xs ${
                        placing === s.id
                          ? 'border-brand-400 bg-brand-500/20'
                          : 'border-ink-600 bg-ink-800 hover:border-brand-400'
                      }`}
                    >
                      {s.name}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-secondary"
              disabled={pinned.length < 2 || autoLink.isPending}
              onClick={() =>
                autoLink.mutate(2, {
                  onSuccess: ({ result }) =>
                    onDone(
                      result.added
                        ? `Linked ${result.added} nearby room${result.added === 1 ? '' : 's'}`
                        : 'Nearby rooms are already linked',
                    ),
                })
              }
            >
              <MapIcon size={14} /> Auto-link nearby rooms
            </button>
            <button
              type="button"
              className="btn-ghost text-red-200"
              disabled={removePlan.isPending}
              onClick={() =>
                removePlan.mutate(undefined, { onSuccess: () => onDone('Floor plan removed') })
              }
            >
              Remove plan
            </button>
          </div>
        </>
      )}
    </div>
  );
}
