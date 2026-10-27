import { useState } from 'react';
import {
  bearingToYaw,
  planBearing,
  yawToBearing,
  type FloorPlanDTO,
  type ViewerSceneDTO,
} from '@btv/shared';
import { ChevronUpIcon, MapIcon } from '../components/icons';

/** Collapsible floor plan with a pin per placed scene and a cone showing where the camera looks. */
export function MiniMap({
  floorPlan,
  scenes,
  currentId,
  heading,
  onSelect,
  className = '',
}: {
  floorPlan: FloorPlanDTO;
  scenes: ViewerSceneDTO[];
  currentId: string;
  /** Current camera yaw. */
  heading: number;
  onSelect: (sceneId: string, walkYaw?: number) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(true);
  const pinned = scenes.filter((s) => s.mapX !== null && s.mapY !== null);
  if (pinned.length === 0) return null;
  const aspect = floorPlan.width / floorPlan.height;
  const current = pinned.find((s) => s.id === currentId);

  return (
    <div data-viewer-ui className={`absolute left-3 z-[1] ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-full bg-black/55 px-3 py-1.5 text-xs font-medium text-white backdrop-blur hover:bg-black/75"
      >
        <MapIcon size={14} /> Floor plan
        <ChevronUpIcon size={12} className={open ? '' : 'rotate-180'} />
      </button>
      {open && (
        <div
          className="relative mt-2 w-40 overflow-hidden rounded-xl border border-white/15 bg-white/90 shadow-xl sm:w-52"
          style={{ aspectRatio: `${floorPlan.width} / ${floorPlan.height}` }}
        >
          <img
            src={floorPlan.url}
            alt=""
            className="absolute inset-0 h-full w-full object-contain"
            draggable={false}
          />
          <ul aria-label="Rooms on the floor plan">
            {pinned.map((s) => {
              const isCurrent = s.id === currentId;
              const walkYaw =
                current && !isCurrent
                  ? bearingToYaw(
                      planBearing(
                        { x: current.mapX!, y: current.mapY! },
                        { x: s.mapX!, y: s.mapY! },
                        aspect,
                      ),
                      current.northOffset,
                    )
                  : undefined;
              return (
                <li
                  key={s.id}
                  className="absolute -translate-x-1/2 -translate-y-1/2"
                  style={{ left: `${s.mapX! * 100}%`, top: `${s.mapY! * 100}%` }}
                >
                  {isCurrent && (
                    <svg
                      viewBox="-50 -50 100 100"
                      className="pointer-events-none absolute left-1/2 top-1/2 h-16 w-16"
                      style={{
                        transform: `translate(-50%, -50%) rotate(${yawToBearing(heading, s.northOffset)}deg)`,
                      }}
                      aria-hidden="true"
                    >
                      <path d="M0 0 L-22 -46 A50 50 0 0 1 22 -46 Z" fill="rgba(14,165,233,0.45)" />
                    </svg>
                  )}
                  <button
                    type="button"
                    onClick={() => !isCurrent && onSelect(s.id, walkYaw)}
                    aria-current={isCurrent ? 'location' : undefined}
                    aria-label={isCurrent ? `You are in ${s.name}` : `Go to ${s.name}`}
                    title={s.name}
                    className={`relative block rounded-full border-2 border-white shadow ${
                      isCurrent
                        ? 'h-4 w-4 bg-brand-500 ring-2 ring-brand-300'
                        : 'h-3.5 w-3.5 bg-ink-700 hover:bg-brand-400'
                    }`}
                  />
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
