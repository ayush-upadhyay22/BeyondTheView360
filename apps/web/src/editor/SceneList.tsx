import { useState } from 'react';
import type { SceneDTO } from '@btv/shared';
import {
  ChevronDownIcon,
  ChevronUpIcon,
  GripIcon,
  RefreshIcon,
  TrashIcon,
} from '../components/icons';
import { Spinner } from '../components/feedback';
import { AutoField } from './AutoField';

const STATUS_LABEL: Record<SceneDTO['status'], string> = {
  pending: 'Uploading',
  queued: 'Queued',
  processing: 'Processing',
  ready: 'Ready',
  failed: 'Failed',
};

function SceneStatus({ scene, onRetry }: { scene: SceneDTO; onRetry: () => void }) {
  if (scene.status === 'ready') return null;
  if (scene.status === 'failed') {
    return (
      <div className="mt-1.5 rounded-md bg-red-500/10 px-2 py-1.5 text-xs text-red-200">
        <p>{scene.error ?? 'Processing failed.'}</p>
        <button
          type="button"
          className="mt-1 inline-flex items-center gap-1 font-medium text-red-100 hover:underline"
          onClick={onRetry}
        >
          <RefreshIcon size={12} /> Retry
        </button>
      </div>
    );
  }
  const pct = Math.round(scene.progress);
  return (
    <div className="mt-1.5 text-xs text-slate-400" aria-live="polite">
      <div className="flex items-center gap-1.5">
        <Spinner size={12} label={STATUS_LABEL[scene.status]} />
        {STATUS_LABEL[scene.status]}
        {scene.status === 'processing' && ` · ${pct}%`}
      </div>
      {scene.status === 'processing' && (
        <div className="mt-1 h-1 overflow-hidden rounded bg-ink-600">
          <div className="h-full bg-brand-400 transition-[width]" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

export function SceneList({
  scenes,
  currentId,
  startSceneId,
  onSelect,
  onRename,
  onReorder,
  onDelete,
  onRetry,
}: {
  scenes: SceneDTO[];
  currentId: string | null;
  startSceneId: string | null;
  onSelect: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onReorder: (ids: string[]) => void;
  onDelete: (scene: SceneDTO) => void;
  onRetry: (id: string) => void;
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

  function move(id: string, toIndex: number) {
    const ids = scenes.map((s) => s.id).filter((x) => x !== id);
    ids.splice(Math.max(0, Math.min(ids.length, toIndex)), 0, id);
    if (ids.join() !== scenes.map((s) => s.id).join()) onReorder(ids);
  }

  if (scenes.length === 0) {
    return <p className="px-1 py-4 text-center text-sm text-slate-500">No scenes yet.</p>;
  }

  return (
    <ol className="space-y-1.5" aria-label="Scenes">
      {scenes.map((s, index) => (
        <li
          key={s.id}
          draggable={renaming !== s.id}
          onDragStart={(e) => {
            setDragId(s.id);
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', s.id);
          }}
          onDragOver={(e) => {
            if (!dragId) return;
            e.preventDefault();
            setOverId(s.id);
          }}
          onDragLeave={() => setOverId((o) => (o === s.id ? null : o))}
          onDrop={(e) => {
            e.preventDefault();
            if (dragId && dragId !== s.id) move(dragId, index);
            setDragId(null);
            setOverId(null);
          }}
          onDragEnd={() => {
            setDragId(null);
            setOverId(null);
          }}
          className={`group rounded-xl border p-2 transition ${
            s.id === currentId
              ? 'border-brand-400/70 bg-brand-500/10'
              : 'border-transparent bg-ink-800/60 hover:bg-ink-800'
          } ${overId === s.id && dragId !== s.id ? 'ring-2 ring-brand-400' : ''} ${
            dragId === s.id ? 'opacity-50' : ''
          }`}
        >
          <div className="flex items-center gap-2">
            <span className="cursor-grab text-slate-500" aria-hidden="true">
              <GripIcon size={16} />
            </span>
            <button
              type="button"
              className="h-10 w-20 shrink-0 overflow-hidden rounded-md bg-ink-700"
              onClick={() => onSelect(s.id)}
              aria-label={`Show ${s.name}`}
              aria-current={s.id === currentId ? 'true' : undefined}
            >
              {s.thumbUrl && (
                <img
                  src={s.thumbUrl}
                  alt=""
                  className="h-full w-full object-cover"
                  loading="lazy"
                />
              )}
            </button>
            <div className="min-w-0 flex-1">
              {renaming === s.id ? (
                <div
                  onBlur={() => setRenaming(null)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === 'Escape') setRenaming(null);
                  }}
                >
                  <AutoField
                    key={s.id}
                    label="Scene name"
                    hideLabel
                    autoFocus
                    value={s.name}
                    maxLength={120}
                    validate={(v) => (v.trim() ? null : 'Name cannot be empty')}
                    onSave={(name) => onRename(s.id, name)}
                  />
                </div>
              ) : (
                <button
                  type="button"
                  className="block w-full truncate text-left text-sm font-medium"
                  onClick={() => onSelect(s.id)}
                  onDoubleClick={() => setRenaming(s.id)}
                  title="Double-click to rename"
                >
                  {s.name}
                </button>
              )}
              {s.id === startSceneId && (
                <span className="text-[11px] font-medium uppercase tracking-wide text-brand-300">
                  Start scene
                </span>
              )}
            </div>
            <div className="flex shrink-0 flex-col opacity-60 group-hover:opacity-100">
              <button
                type="button"
                className="text-slate-400 hover:text-white disabled:opacity-30"
                disabled={index === 0}
                onClick={() => move(s.id, index - 1)}
                aria-label={`Move ${s.name} up`}
              >
                <ChevronUpIcon size={14} />
              </button>
              <button
                type="button"
                className="text-slate-400 hover:text-white disabled:opacity-30"
                disabled={index === scenes.length - 1}
                onClick={() => move(s.id, index + 1)}
                aria-label={`Move ${s.name} down`}
              >
                <ChevronDownIcon size={14} />
              </button>
            </div>
            <div className="flex shrink-0 flex-col gap-1">
              <button
                type="button"
                className="rounded p-1 text-slate-500 hover:bg-ink-700 hover:text-white"
                onClick={() => setRenaming(s.id)}
                aria-label={`Rename ${s.name}`}
                title="Rename"
              >
                <span aria-hidden="true" className="block text-xs leading-none">
                  ✎
                </span>
              </button>
              <button
                type="button"
                className="rounded p-1 text-slate-500 hover:bg-red-500/20 hover:text-red-200"
                onClick={() => onDelete(s)}
                aria-label={`Delete ${s.name}`}
                title="Delete"
              >
                <TrashIcon size={14} />
              </button>
            </div>
          </div>
          <SceneStatus scene={s} onRetry={() => onRetry(s.id)} />
        </li>
      ))}
    </ol>
  );
}
