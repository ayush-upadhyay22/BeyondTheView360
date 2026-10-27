import { useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { parseViewerParams, type PublicTourDTO } from '@btv/shared';
import { BRAND } from '../config';
import { get, post } from './api';

export function usePublicTour(shareId: string) {
  return useQuery({
    queryKey: ['public-tour', shareId],
    queryFn: async () =>
      (await get<{ tour: PublicTourDTO }>(`/public/tours/${encodeURIComponent(shareId)}`)).tour,
    // Signed image URLs stay valid for a while; refresh well before they expire.
    staleTime: 5 * 60_000,
    refetchInterval: 10 * 60_000,
  });
}

/** Counts one view per browser session. No identifiers are stored server-side. */
export function useViewPing(shareId: string, ready: boolean) {
  useEffect(() => {
    if (!ready) return;
    const key = `btv:viewed:${shareId}`;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, '1');
    } catch {
      // Storage can be blocked (e.g. some embedded contexts); count the view anyway.
    }
    post(`/public/tours/${encodeURIComponent(shareId)}/views`).catch(() => undefined);
  }, [shareId, ready]);
}

export function useDocumentTitle(title: string | undefined) {
  useEffect(() => {
    document.title = title ? `${title} · ${BRAND.name}` : BRAND.name;
    return () => {
      document.title = BRAND.name;
    };
  }, [title]);
}

/** Player props from `?scene=<id>&autoplay=1&ui=0` (unknown scene ids fall back to the start). */
export function useViewerParams(tour: PublicTourDTO | undefined) {
  const [search] = useSearchParams();
  const params = useMemo(() => parseViewerParams(search), [search]);
  const deepLinked =
    !!params.sceneId && !!tour?.scenes.some((s) => s.id === params.sceneId) ? params.sceneId : null;
  return {
    ui: params.ui,
    autoplay: params.autoplay,
    startSceneId: deepLinked ?? tour?.startSceneId ?? null,
    // The tour's start view belongs to its start scene; a deep-linked scene uses its own.
    startView: deepLinked && deepLinked !== tour?.startSceneId ? null : (tour?.startView ?? null),
  };
}
