import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ALLOWED_UPLOAD_TYPES } from '@btv/shared';
import { CloseIcon, UploadIcon } from '../components/icons';
import { errorMessage } from '../lib/api';
import { tourKey, toursKey } from '../lib/queries';
import { formatBytes, precheckFile, presignUpload, uploadPanorama } from '../lib/upload';

const PARALLEL_UPLOADS = 3;

interface UploadItem {
  key: string;
  file: File;
  progress: number;
  state: 'waiting' | 'uploading' | 'done' | 'error' | 'cancelled';
  error?: string;
  abort?: AbortController;
}

export function Uploader({
  tourId,
  maxBytes,
  remaining,
}: {
  tourId: string;
  maxBytes: number;
  /** Scenes still allowed by the plan. */
  remaining: number;
}) {
  const qc = useQueryClient();
  const [items, setItems] = useState<UploadItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const counter = useRef(0);
  const presignChain = useRef<Promise<unknown>>(Promise.resolve());

  const update = useCallback(
    (key: string, patch: Partial<UploadItem>) =>
      setItems((list) => list.map((i) => (i.key === key ? { ...i, ...patch } : i))),
    [],
  );

  const active = items.filter((i) => i.state === 'uploading').length;
  const busy = items.some((i) => i.state === 'uploading' || i.state === 'waiting');

  // Start waiting uploads while there are free slots.
  useEffect(() => {
    const free = PARALLEL_UPLOADS - active;
    const next = items.filter((i) => i.state === 'waiting').slice(0, Math.max(0, free));
    for (const item of next) {
      const abort = new AbortController();
      update(item.key, { state: 'uploading', abort });
      // Presigns run one at a time so scene positions follow the order files were added.
      const presigned = presignChain.current.then(() => presignUpload(tourId, item.file));
      presignChain.current = presigned.catch(() => undefined);
      uploadPanorama(
        tourId,
        item.file,
        (p) => update(item.key, { progress: p }),
        abort.signal,
        presigned,
      )
        .then(() => {
          update(item.key, { state: 'done', progress: 1 });
          setTimeout(() => setItems((l) => l.filter((i) => i.key !== item.key)), 2500);
        })
        .catch((err: unknown) => {
          if (abort.signal.aborted) update(item.key, { state: 'cancelled' });
          else update(item.key, { state: 'error', error: errorMessage(err) });
        })
        .finally(() => {
          void qc.invalidateQueries({ queryKey: tourKey(tourId) });
          void qc.invalidateQueries({ queryKey: toursKey });
        });
    }
  }, [items, active, tourId, update, qc]);

  // Warn before leaving the page mid-upload.
  useEffect(() => {
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy]);

  function addFiles(files: FileList | File[]) {
    let slots =
      remaining - items.filter((i) => i.state === 'waiting' || i.state === 'uploading').length;
    const added: UploadItem[] = [...files].map((file) => {
      const key = `u${++counter.current}`;
      const problem = precheckFile(file, maxBytes);
      if (problem) return { key, file, progress: 0, state: 'error', error: problem };
      if (slots <= 0) {
        return {
          key,
          file,
          progress: 0,
          state: 'error',
          error: 'Scene limit for this tour reached.',
        };
      }
      slots -= 1;
      return { key, file, progress: 0, state: 'waiting' };
    });
    setItems((list) => [...list, ...added]);
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  }

  return (
    <div className="space-y-2">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`rounded-xl border-2 border-dashed p-4 text-center transition ${
          dragging ? 'border-brand-400 bg-brand-500/10' : 'border-ink-600 hover:border-ink-500'
        }`}
      >
        <UploadIcon size={24} className="mx-auto mb-2 text-brand-300" />
        <p className="text-sm">
          Drop 360° photos here or{' '}
          <button
            type="button"
            className="font-medium text-brand-300 hover:underline"
            onClick={() => inputRef.current?.click()}
          >
            browse
          </button>
        </p>
        <p className="mt-1 text-xs text-slate-500">
          Equirectangular 2:1 · JPEG, PNG or WebP · up to {formatBytes(maxBytes)}
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ALLOWED_UPLOAD_TYPES.join(',')}
          className="sr-only"
          tabIndex={-1}
          aria-label="Choose panorama files"
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      {items.length > 0 && (
        <ul className="space-y-1.5" aria-label="Uploads">
          {items.map((item) => (
            <li key={item.key} className="rounded-lg bg-ink-800 px-3 py-2 text-xs">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate" title={item.file.name}>
                  {item.file.name}
                </span>
                <span className="shrink-0 text-slate-400">
                  {item.state === 'uploading' && `${Math.round(item.progress * 100)}%`}
                  {item.state === 'waiting' && 'Waiting'}
                  {item.state === 'done' && 'Uploaded'}
                  {item.state === 'cancelled' && 'Cancelled'}
                </span>
                {(item.state === 'uploading' || item.state === 'waiting') && (
                  <button
                    type="button"
                    className="text-slate-400 hover:text-white"
                    aria-label={`Cancel upload of ${item.file.name}`}
                    onClick={() =>
                      item.abort ? item.abort.abort() : update(item.key, { state: 'cancelled' })
                    }
                  >
                    <CloseIcon size={14} />
                  </button>
                )}
                {(item.state === 'error' || item.state === 'cancelled') && (
                  <button
                    type="button"
                    className="text-slate-400 hover:text-white"
                    aria-label={`Dismiss ${item.file.name}`}
                    onClick={() => setItems((l) => l.filter((i) => i.key !== item.key))}
                  >
                    <CloseIcon size={14} />
                  </button>
                )}
              </div>
              {item.state === 'uploading' && (
                <div
                  className="mt-1.5 h-1 overflow-hidden rounded bg-ink-600"
                  role="progressbar"
                  aria-label={`Uploading ${item.file.name}`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(item.progress * 100)}
                >
                  <div
                    className="h-full bg-brand-400 transition-[width]"
                    style={{ width: `${item.progress * 100}%` }}
                  />
                </div>
              )}
              {item.error && <p className="mt-1 text-red-300">{item.error}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
