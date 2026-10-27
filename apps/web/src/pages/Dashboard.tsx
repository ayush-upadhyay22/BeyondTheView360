import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { TourSummaryDTO, TourVisibility } from '@btv/shared';
import { PageShell } from '../components/Layout';
import { Dialog } from '../components/Dialog';
import { SharePanel } from '../components/SharePanel';
import { EmptyState, ErrorState, InlineError } from '../components/feedback';
import { EyeIcon, ImagesIcon, LinkIcon, PlusIcon, TrashIcon } from '../components/icons';
import { errorMessage } from '../lib/api';
import { useMe } from '../lib/auth';
import { useCreateTour, useDeleteTour, useTours } from '../lib/queries';

const VISIBILITY_STYLE: Record<TourVisibility, string> = {
  private: 'bg-slate-500/20 text-slate-300',
  unlisted: 'bg-amber-500/15 text-amber-200',
  public: 'bg-emerald-500/15 text-emerald-200',
};

export function VisibilityBadge({ visibility }: { visibility: TourVisibility }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${VISIBILITY_STYLE[visibility]}`}
    >
      {visibility}
    </span>
  );
}

function CreateTourForm({ used, max }: { used: number; max: number }) {
  const [title, setTitle] = useState('');
  const create = useCreateTour();
  const navigate = useNavigate();
  const atLimit = used >= max;

  function submit(e: FormEvent) {
    e.preventDefault();
    const t = title.trim();
    if (!t) return;
    create.mutate(t, { onSuccess: (tour) => navigate(`/app/tours/${tour.id}`) });
  }

  return (
    <form onSubmit={submit} className="card flex flex-col gap-3 p-4 sm:flex-row sm:items-end">
      <div className="flex-1">
        <label className="label" htmlFor="new-tour">
          New tour
        </label>
        <input
          id="new-tour"
          className="input"
          placeholder="e.g. Riverside loft, 2nd floor"
          maxLength={120}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={atLimit}
        />
      </div>
      <button
        type="submit"
        className="btn-primary"
        disabled={atLimit || !title.trim() || create.isPending}
      >
        <PlusIcon size={16} />
        {create.isPending ? 'Creating…' : 'Create tour'}
      </button>
      <div className="text-xs text-slate-500 sm:w-40 sm:text-right">
        {used} of {max} tours used
        {atLimit && <span className="block text-amber-300">Plan limit reached</span>}
      </div>
      {create.isError && (
        <div className="sm:basis-full">
          <InlineError>{errorMessage(create.error)}</InlineError>
        </div>
      )}
    </form>
  );
}

function TourCard({
  tour,
  onShare,
  onDelete,
}: {
  tour: TourSummaryDTO;
  onShare: () => void;
  onDelete: () => void;
}) {
  return (
    <li className="card group flex flex-col overflow-hidden">
      <Link
        to={`/app/tours/${tour.id}`}
        className="relative block aspect-[2/1] bg-ink-800"
        aria-label={`Edit ${tour.title}`}
      >
        {tour.thumbnailUrl ? (
          <img
            src={tour.thumbnailUrl}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover transition duration-500 group-hover:scale-[1.03]"
          />
        ) : (
          <div className="grid h-full place-items-center text-slate-600">
            <ImagesIcon size={36} />
          </div>
        )}
      </Link>
      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <Link
            to={`/app/tours/${tour.id}`}
            className="line-clamp-2 font-semibold hover:text-brand-200"
          >
            {tour.title}
          </Link>
          <VisibilityBadge visibility={tour.visibility} />
        </div>
        <div className="flex gap-4 text-xs text-slate-400">
          <span>
            {tour.sceneCount} {tour.sceneCount === 1 ? 'scene' : 'scenes'}
          </span>
          <span className="flex items-center gap-1">
            <EyeIcon size={14} /> {tour.viewCount.toLocaleString()} views
          </span>
        </div>
        <div className="mt-auto flex gap-2">
          <Link to={`/app/tours/${tour.id}`} className="btn-secondary flex-1">
            Edit
          </Link>
          <button type="button" className="btn-secondary" onClick={onShare}>
            <LinkIcon size={16} />
            Share
          </button>
          <button
            type="button"
            className="btn-ghost px-3"
            onClick={onDelete}
            aria-label={`Delete ${tour.title}`}
          >
            <TrashIcon size={16} />
          </button>
        </div>
      </div>
    </li>
  );
}

function TourGridSkeleton() {
  return (
    <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <li key={i} className="card overflow-hidden">
          <div className="skeleton aspect-[2/1] rounded-none" />
          <div className="space-y-3 p-4">
            <div className="skeleton h-5 w-2/3" />
            <div className="skeleton h-4 w-1/3" />
            <div className="skeleton h-9 w-full" />
          </div>
        </li>
      ))}
    </ul>
  );
}

export default function Dashboard() {
  const me = useMe();
  const tours = useTours();
  const remove = useDeleteTour();
  const [sharing, setSharing] = useState<TourSummaryDTO | null>(null);

  const maxTours = me.data?.limits.maxTours ?? 0;

  function confirmDelete(t: TourSummaryDTO) {
    const ok = window.confirm(
      `Delete “${t.title}”? All of its scenes and images will be permanently removed.`,
    );
    if (ok) remove.mutate(t.id);
  }

  return (
    <PageShell>
      <div className="mx-auto max-w-7xl space-y-8 px-4 py-8">
        <div>
          <h1 className="text-2xl font-semibold">My tours</h1>
          <p className="text-sm text-slate-400">Create a tour, upload 360° photos, link them up.</p>
        </div>

        {tours.data && <CreateTourForm used={tours.data.length} max={maxTours} />}
        {remove.isError && <InlineError>{errorMessage(remove.error)}</InlineError>}

        {tours.isPending ? (
          <TourGridSkeleton />
        ) : tours.isError ? (
          <ErrorState
            message={errorMessage(tours.error)}
            action={
              <button type="button" className="btn-secondary" onClick={() => void tours.refetch()}>
                Try again
              </button>
            }
          />
        ) : tours.data.length === 0 ? (
          <EmptyState
            icon={<ImagesIcon size={40} />}
            title="No tours yet"
            message="Give your first tour a name above, then drop your equirectangular photos into the editor."
          />
        ) : (
          <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {tours.data.map((t) => (
              <TourCard
                key={t.id}
                tour={t}
                onShare={() => setSharing(t)}
                onDelete={() => confirmDelete(t)}
              />
            ))}
          </ul>
        )}
      </div>

      <Dialog open={!!sharing} onClose={() => setSharing(null)} title="Share tour" wide>
        {sharing && (
          <SharePanel
            shareId={sharing.shareId}
            title={sharing.title}
            visibility={sharing.visibility}
          />
        )}
      </Dialog>
    </PageShell>
  );
}
