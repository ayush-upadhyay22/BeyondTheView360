import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { BRAND } from '../config';
import { TourPlayer } from '../viewer/TourPlayer';
import { createDemoScenes } from '../viewer/demoPanorama';

/** Self-contained viewer demo: panoramas are drawn in the browser, no uploads needed. */
export default function Demo() {
  const scenes = useMemo(createDemoScenes, []);
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-ink-700 px-4 py-2 text-sm">
        <Link to="/" className="font-semibold">
          {BRAND.name}
        </Link>
        <span className="hidden text-slate-400 sm:inline">
          Viewer demo — generated test panoramas
        </span>
      </div>
      <TourPlayer scenes={scenes} title="Viewer demo" className="flex-1" />
    </div>
  );
}
