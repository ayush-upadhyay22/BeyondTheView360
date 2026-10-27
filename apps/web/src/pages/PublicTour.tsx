import { Link, useParams } from 'react-router-dom';
import { BRAND } from '../config';
import { Logo } from '../components/Layout';
import { EmptyState, ErrorState, FullPageSpinner } from '../components/feedback';
import { ImagesIcon } from '../components/icons';
import { ApiError, errorMessage } from '../lib/api';
import { useMe } from '../lib/auth';
import { useDocumentTitle, usePublicTour, useViewPing } from '../lib/publicTour';
import { TourPlayer } from '../viewer/TourPlayer';

export function TourUnavailable({ error, compact = false }: { error: unknown; compact?: boolean }) {
  const missing = error instanceof ApiError && error.status === 404;
  return (
    <div className="grid h-full min-h-[60vh] place-items-center p-6">
      <ErrorState
        title={missing ? 'Tour not available' : 'Could not load this tour'}
        message={
          missing
            ? 'The link may be wrong, the tour may have been removed, or its owner made it private.'
            : errorMessage(error)
        }
        action={
          compact ? undefined : (
            <Link to="/" className="btn-secondary">
              Go to {BRAND.name}
            </Link>
          )
        }
      />
    </div>
  );
}

export function NoScenes() {
  return (
    <div className="grid h-full min-h-[60vh] place-items-center p-6">
      <EmptyState
        icon={<ImagesIcon size={40} />}
        title="Nothing to see yet"
        message="This tour has no finished scenes. Check back soon."
      />
    </div>
  );
}

export default function PublicTour() {
  const { shareId = '' } = useParams();
  const query = usePublicTour(shareId);
  const me = useMe();
  const tour = query.data;
  useDocumentTitle(tour?.title);
  useViewPing(shareId, !!tour && tour.scenes.length > 0);

  if (query.isPending) return <FullPageSpinner />;
  if (query.isError || !tour) return <TourUnavailable error={query.error} />;

  return (
    <div className="flex h-[100dvh] flex-col bg-ink-950">
      {tour.visibility === 'private' && (
        <div className="bg-amber-500/15 px-4 py-1.5 text-center text-xs text-amber-200">
          This tour is private: only you can see this page.{' '}
          {me.data && (
            <Link to="/app" className="underline">
              Change visibility in the editor
            </Link>
          )}
        </div>
      )}
      <main className="relative min-h-0 flex-1">
        {tour.scenes.length === 0 ? (
          <NoScenes />
        ) : (
          <div className="absolute inset-0">
            <TourPlayer
              className="h-full w-full"
              scenes={tour.scenes}
              startSceneId={tour.startSceneId}
              startView={tour.startView}
              title={tour.title}
              chrome="full"
            />
          </div>
        )}
      </main>
      <footer className="flex items-center justify-between gap-4 border-t border-ink-800 px-4 py-2 text-xs text-slate-400">
        <p className="line-clamp-1 min-w-0">{tour.description}</p>
        <span className="flex shrink-0 items-center gap-2">
          Made with <Logo className="text-slate-200" />
        </span>
      </footer>
    </div>
  );
}
