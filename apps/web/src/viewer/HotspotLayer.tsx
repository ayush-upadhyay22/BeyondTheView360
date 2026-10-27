import { useEffect, useRef } from 'react';
import type { HotspotDTO } from '@btv/shared';
import { ArrowUpIcon, InfoIcon } from '../components/icons';
import type { PanoramaEngine } from './PanoramaEngine';

interface Props {
  engine: PanoramaEngine;
  hotspots: HotspotDTO[];
  /** Label for link hotspots without a title (usually the target scene's name). */
  labelFor: (h: HotspotDTO) => string;
  editable: boolean;
  selectedId?: string | null;
  onActivate: (h: HotspotDTO) => void;
  onMove?: (h: HotspotDTO, pos: { yaw: number; pitch: number }) => void;
}

/**
 * DOM hotspot markers kept in place by repositioning them on every rendered frame.
 * Positions are written straight to element styles, so rotating never re-renders React.
 */
export function HotspotLayer({
  engine,
  hotspots,
  labelFor,
  editable,
  selectedId,
  onActivate,
  onMove,
}: Props) {
  const elements = useRef(new Map<string, HTMLElement>());
  const overrides = useRef(new Map<string, { yaw: number; pitch: number }>());
  const latest = useRef(hotspots);
  latest.current = hotspots;

  useEffect(() => {
    const update = () => {
      for (const h of latest.current) {
        const el = elements.current.get(h.id);
        if (!el) continue;
        const pos = overrides.current.get(h.id) ?? h;
        const p = engine.project(pos.yaw, pos.pitch);
        el.style.visibility = p.visible ? 'visible' : 'hidden';
        el.style.transform = `translate3d(${p.x}px, ${p.y}px, 0) translate(-50%, -50%)`;
      }
    };
    const off = engine.onFrame(update);
    update();
    return off;
  }, [engine]);

  useEffect(() => {
    // Server state caught up with a drag: drop the local override.
    for (const id of [...overrides.current.keys()]) {
      if (!hotspots.some((h) => h.id === id)) overrides.current.delete(id);
    }
    engine.invalidate();
  }, [hotspots, engine]);

  function startDrag(e: React.PointerEvent<HTMLButtonElement>, h: HotspotDTO) {
    if (!editable || e.button > 0) return;
    e.stopPropagation();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const start = { x: e.clientX, y: e.clientY };
    let moved = false;

    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 4) return;
      moved = true;
      overrides.current.set(h.id, engine.unproject(ev.clientX, ev.clientY));
      engine.invalidate();
    };
    const up = (ev: PointerEvent) => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      if (moved) {
        const pos = engine.unproject(ev.clientX, ev.clientY);
        overrides.current.set(h.id, pos);
        onMove?.(h, pos);
      } else {
        onActivate(h);
      }
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  }

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" data-viewer-ui>
      {hotspots.map((h) => {
        const label = h.type === 'link' ? h.title || labelFor(h) : h.title;
        const selected = selectedId === h.id;
        return (
          <button
            key={h.id}
            ref={(el) => {
              if (el) elements.current.set(h.id, el);
              else elements.current.delete(h.id);
            }}
            type="button"
            data-viewer-ui
            className={`group pointer-events-auto absolute left-0 top-0 ${
              editable ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'
            }`}
            style={{ visibility: 'hidden', touchAction: 'none' }}
            aria-label={h.type === 'link' ? `Go to scene: ${label}` : `Show information: ${label}`}
            title={editable ? `${label} — drag to move, click to edit` : label}
            onPointerDown={(e) => startDrag(e, h)}
            onClick={(e) => {
              e.stopPropagation();
              // In edit mode pointer clicks are handled by startDrag; keyboard (detail 0) lands here.
              if (!editable || e.detail === 0) onActivate(h);
            }}
          >
            <span className="relative grid h-11 w-11 place-items-center">
              <span
                className={`absolute inset-0 rounded-full motion-safe:animate-pulse-ring ${
                  h.type === 'link' ? 'bg-brand-400/50' : 'bg-ember-400/50'
                }`}
              />
              <span
                className={`relative grid h-10 w-10 place-items-center rounded-full border-2 text-white shadow-lg shadow-black/40 ${
                  h.type === 'link'
                    ? 'border-white/90 bg-brand-500/90'
                    : 'border-white/90 bg-ember-500/90'
                } ${selected ? 'ring-4 ring-white' : ''}`}
              >
                {h.type === 'link' ? <ArrowUpIcon size={18} /> : <InfoIcon size={18} />}
              </span>
            </span>
            {label && (
              <span className="pointer-events-none absolute left-1/2 top-full mt-1 max-w-[14rem] -translate-x-1/2 truncate whitespace-nowrap rounded-md bg-black/70 px-2 py-1 text-xs font-medium text-white opacity-0 backdrop-blur transition group-hover:opacity-100 group-focus-visible:opacity-100">
                {label}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
