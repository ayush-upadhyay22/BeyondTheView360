import { useParams } from 'react-router-dom';
import { BRAND } from '../config';
import { Spinner } from '../components/feedback';
import { usePublicTour, useDocumentTitle, useViewPing } from '../lib/publicTour';
import { shareUrl } from '../lib/share';
import { TourPlayer } from '../viewer/TourPlayer';
import { NoScenes, TourUnavailable } from './PublicTour';

/** Chrome-less page meant to live inside an <iframe> on other sites. */
export default function EmbedTour() {
  const { shareId = '' } = useParams();
  const query = usePublicTour(shareId);
  const tour = query.data;
  useDocumentTitle(tour?.title);
  useViewPing(shareId, !!tour && tour.scenes.length > 0);

  return (
    <div className="relative h-[100dvh] overflow-hidden bg-ink-950 text-white">
      {query.isPending ? (
        <div className="grid h-full place-items-center">
          <Spinner size={28} />
        </div>
      ) : query.isError || !tour ? (
        <TourUnavailable error={query.error} compact />
      ) : tour.scenes.length === 0 ? (
        <NoScenes />
      ) : (
        <TourPlayer
          className="h-full w-full"
          scenes={tour.scenes}
          startSceneId={tour.startSceneId}
          startView={tour.startView}
          title={tour.title}
          chrome="full"
        >
          <a
            href={shareUrl(shareId)}
            target="_blank"
            rel="noopener noreferrer"
            data-viewer-ui
            className="absolute right-[4.5rem] top-5 rounded-full bg-black/50 px-2.5 py-1 text-[11px] text-slate-200 backdrop-blur hover:bg-black/70"
          >
            {BRAND.name} ↗
          </a>
        </TourPlayer>
      )}
    </div>
  );
}
