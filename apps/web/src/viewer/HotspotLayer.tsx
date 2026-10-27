import { useEffect, useRef } from 'react';
import type { HotspotDTO } from '@btv/shared';
import { ArrowDownIcon, ArrowUpIcon, InfoIcon, LinkIcon } from '../components/icons';
import type { PanoramaEngine } from './PanoramaEngine';

interface Props {
  engine: PanoramaEngine;
  hotspots: HotspotDTO[];
  /** Name of the scene a navigation hotspot leads to. */
  sceneName: (h: HotspotDTO) => string;
  editable: boolean;
  selectedId?: string | null;
  onActivate: (h: HotspotDTO) => void;
  onMove?: (h: HotspotDTO, pos: { yaw: number; pitch: number }) => void;
}

/** Pointer travel (px) after which a press counts as a drag and never activates the hotspot. */
const DRAG_THRESHOLD = 5;

export function hotspotLabel(h: HotspotDTO, sceneName: (h: HotspotDTO) => string): string {
  return h.kind === 'info' ? h.title : h.title || sceneName(h);
}

export function hotspotAriaLabel(h: HotspotDTO, sceneName: (h: HotspotDTO) => string): string {
  return h.kind === 'info' ? `Show information: ${h.title}` : `Go to ${sceneName(h)}`;
}

/**
 * DOM hotspot markers kept in place by repositioning them on every rendered frame, so they stay
 * anchored to the panorama while it rotates. Positions are written straight to element styles,
 * so rotating never re-renders React.
 */
export function HotspotLayer({
  engine,
  hotspots,
  sceneName,
  editable,
  selectedId,
  onActivate,
  onMove,
}: Props) {
  const elements = useRef(new Map<string, HTMLElement>());
  const overrides = useRef(new Map<string, { yaw: number; pitch: number }>());
  const latest = useRef(hotspots);
  latest.current = hotspots;
  /** Set when the last press on a marker turned into a drag; swallows the following click. */
  const dragged = useRef(false);

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
    // Server state caught up with a drag: drop local overrides that now match (or are gone).
    for (const [id, pos] of [...overrides.current]) {
      const h = hotspots.find((x) => x.id === id);
      if (!h || (Math.abs(h.yaw - pos.yaw) < 0.01 && Math.abs(h.pitch - pos.pitch) < 0.01)) {
        overrides.current.delete(id);
      }
    }
    engine.invalidate();
  }, [hotspots, engine]);

  function onPointerDown(e: React.PointerEvent<HTMLButtonElement>, h: HotspotDTO) {
    if (e.button > 0) return;
    dragged.current = false;
    const target = e.currentTarget;
    const start = { x: e.clientX, y: e.clientY };
    if (!editable) {
      // Viewers can't move markers, but a press that slides off must still not navigate.
      const move = (ev: PointerEvent) => {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > DRAG_THRESHOLD) {
          dragged.current = true;
        }
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      return;
    }
    e.stopPropagation();
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      if (
        !dragged.current &&
        Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_THRESHOLD
      ) {
        return;
      }
      dragged.current = true;
      overrides.current.set(h.id, engine.unproject(ev.clientX, ev.clientY));
      engine.invalidate();
    };
    const up = (ev: PointerEvent) => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      if (dragged.current && ev.type === 'pointerup') {
        const pos = engine.unproject(ev.clientX, ev.clientY);
        overrides.current.set(h.id, pos);
        onMove?.(h, pos);
      } else if (ev.type === 'pointercancel') {
        overrides.current.delete(h.id);
        engine.invalidate();
      }
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  }

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" data-viewer-ui>
      {hotspots.map((h) => {
        const label = hotspotLabel(h, sceneName);
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
            data-hotspot-kind={h.kind}
            className={`group pointer-events-auto absolute left-0 top-0 rounded-full focus-visible:outline-none ${
              editable ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'
            }`}
            style={{ visibility: 'hidden', touchAction: 'none' }}
            aria-label={hotspotAriaLabel(h, sceneName)}
            title={editable ? `${label} — drag to move, click to edit` : label}
            onPointerDown={(e) => onPointerDown(e, h)}
            onClick={(e) => {
              e.stopPropagation();
              if (dragged.current) {
                dragged.current = false;
                return;
              }
              onActivate(h);
            }}
          >
            <Marker hotspot={h} label={label} selected={selected} />
          </button>
        );
      })}
    </div>
  );
}

function Marker({
  hotspot: h,
  label,
  selected,
}: {
  hotspot: HotspotDTO;
  label: string;
  selected: boolean;
}) {
  const ring = selected
    ? 'ring-4 ring-white'
    : 'group-focus-visible:ring-4 group-focus-visible:ring-brand-200';

  if (h.kind === 'next' || h.kind === 'back') {
    return (
      <>
        {/* Tilted disc so the arrow reads as lying on the floor. */}
        <span
          className="relative grid h-16 w-16 place-items-center"
          style={{ transform: 'perspective(260px) rotateX(48deg)' }}
        >
          <span className="absolute inset-0 rounded-full bg-white/25 motion-safe:animate-pulse-ring" />
          <span
            className={`relative grid h-14 w-14 place-items-center rounded-full border-[3px] border-white bg-black/45 text-white shadow-xl shadow-black/50 backdrop-blur-sm transition group-hover:scale-110 group-hover:bg-brand-500/80 ${ring}`}
          >
            {h.kind === 'next' ? (
              <ArrowUpIcon size={28} strokeWidth={2.6} />
            ) : (
              <ArrowDownIcon size={28} strokeWidth={2.6} />
            )}
          </span>
        </span>
        <span className="pointer-events-none absolute left-1/2 top-[85%] max-w-[14rem] -translate-x-1/2 truncate whitespace-nowrap rounded-md bg-black/70 px-2 py-0.5 text-xs font-medium text-white opacity-0 backdrop-blur transition group-hover:opacity-100 group-focus-visible:opacity-100">
          {label}
        </span>
      </>
    );
  }

  if (h.kind === 'link') {
    return (
      <span
        className={`flex max-w-[16rem] items-center gap-1.5 rounded-full border-2 border-white/90 bg-brand-500/90 py-1 pl-1.5 pr-3 text-sm font-medium text-white shadow-lg shadow-black/40 transition group-hover:bg-brand-400 ${ring}`}
      >
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-white/20">
          <LinkIcon size={14} />
        </span>
        <span className="truncate">{label}</span>
      </span>
    );
  }

  return (
    <>
      <span className="relative grid h-11 w-11 place-items-center">
        <span className="absolute inset-0 rounded-full bg-ember-400/50 motion-safe:animate-pulse-ring" />
        <span
          className={`relative grid h-10 w-10 place-items-center rounded-full border-2 border-white/90 bg-ember-500/90 text-white shadow-lg shadow-black/40 ${ring}`}
        >
          <InfoIcon size={18} />
        </span>
      </span>
      {label && (
        <span className="pointer-events-none absolute left-1/2 top-full mt-1 max-w-[14rem] -translate-x-1/2 truncate whitespace-nowrap rounded-md bg-black/70 px-2 py-1 text-xs font-medium text-white opacity-0 backdrop-blur transition group-hover:opacity-100 group-focus-visible:opacity-100">
          {label}
        </span>
      )}
    </>
  );
}
