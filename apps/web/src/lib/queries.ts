import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  CreateHotspotInput,
  HotspotDTO,
  SceneDTO,
  TourDTO,
  TourStatsDTO,
  TourSummaryDTO,
  UpdateHotspotInput,
  UpdateSceneInput,
  UpdateTourInput,
} from '@btv/shared';
import { del, get, patch, post, put } from './api';

export const toursKey = ['tours'] as const;
export const tourKey = (id: string) => ['tour', id] as const;
export const statsKey = (id: string) => ['tour', id, 'stats'] as const;

const BUSY = new Set(['pending', 'queued', 'processing']);
export const isBusy = (s: Pick<SceneDTO, 'status'>) => BUSY.has(s.status);

export function useTours() {
  return useQuery({
    queryKey: toursKey,
    queryFn: async () => (await get<{ tours: TourSummaryDTO[] }>('/tours')).tours,
  });
}

export function useTour(id: string) {
  return useQuery({
    queryKey: tourKey(id),
    queryFn: async () => (await get<{ tour: TourDTO }>(`/tours/${id}`)).tour,
    // Poll while any scene is still being uploaded or processed.
    refetchInterval: (q) => (q.state.data?.scenes.some(isBusy) ? 1500 : false),
  });
}

export function useTourStats(id: string, enabled = true) {
  return useQuery({
    queryKey: statsKey(id),
    queryFn: () => get<TourStatsDTO>(`/tours/${id}/stats`),
    enabled,
  });
}

export function useCreateTour() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (title: string) => (await post<{ tour: TourDTO }>('/tours', { title })).tour,
    onSuccess: (tour) => {
      qc.setQueryData(tourKey(tour.id), tour);
      void qc.invalidateQueries({ queryKey: toursKey });
    },
  });
}

export function useDeleteTour() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => del(`/tours/${id}`),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: toursKey });
      const previous = qc.getQueryData<TourSummaryDTO[]>(toursKey);
      qc.setQueryData<TourSummaryDTO[]>(toursKey, (list) => list?.filter((t) => t.id !== id));
      return { previous };
    },
    onError: (_err, _id, ctx) => qc.setQueryData(toursKey, ctx?.previous),
    onSettled: (_d, _e, id) => {
      qc.removeQueries({ queryKey: tourKey(id) });
      void qc.invalidateQueries({ queryKey: toursKey });
    },
  });
}

/**
 * Optimistic edits of the cached TourDTO: apply `change` immediately, roll back on error and
 * always resync with the server afterwards.
 */
function useTourMutation<TVars, TResult>(
  tourId: string,
  mutationFn: (vars: TVars) => Promise<TResult>,
  change: (tour: TourDTO, vars: TVars) => TourDTO,
  onSuccess?: (result: TResult, qc: QueryClient) => void,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ['tour-edit', tourId],
    mutationFn,
    onMutate: async (vars: TVars) => {
      await qc.cancelQueries({ queryKey: tourKey(tourId) });
      const previous = qc.getQueryData<TourDTO>(tourKey(tourId));
      if (previous) qc.setQueryData(tourKey(tourId), change(previous, vars));
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(tourKey(tourId), ctx.previous);
    },
    onSuccess: (result) => onSuccess?.(result, qc),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: tourKey(tourId) });
      void qc.invalidateQueries({ queryKey: toursKey });
    },
  });
}

const mapScene = (tour: TourDTO, sceneId: string, fn: (s: SceneDTO) => SceneDTO): TourDTO => ({
  ...tour,
  scenes: tour.scenes.map((s) => (s.id === sceneId ? fn(s) : s)),
});

const mapHotspots = (tour: TourDTO, fn: (h: HotspotDTO[], s: SceneDTO) => HotspotDTO[]) => ({
  ...tour,
  scenes: tour.scenes.map((s) => ({ ...s, hotspots: fn(s.hotspots, s) })),
});

export function useUpdateTour(tourId: string) {
  return useTourMutation(
    tourId,
    (input: UpdateTourInput) => patch<{ tour: TourDTO }>(`/tours/${tourId}`, input),
    (tour, input) => ({ ...tour, ...input }),
  );
}

export function useUpdateScene(tourId: string) {
  return useTourMutation(
    tourId,
    ({ id, ...input }: UpdateSceneInput & { id: string }) =>
      patch<{ scene: SceneDTO }>(`/scenes/${id}`, input),
    (tour, { id, ...input }) => mapScene(tour, id, (s) => ({ ...s, ...input })),
  );
}

export function useDeleteScene(tourId: string) {
  return useTourMutation(
    tourId,
    (id: string) => del(`/scenes/${id}`),
    (tour, id) => {
      const next = mapHotspots(tour, (hs) => hs.filter((h) => h.targetSceneId !== id));
      return {
        ...next,
        startSceneId: tour.startSceneId === id ? null : tour.startSceneId,
        scenes: next.scenes.filter((s) => s.id !== id),
        sceneCount: tour.sceneCount - 1,
      };
    },
  );
}

export function useRetryScene(tourId: string) {
  return useTourMutation(
    tourId,
    (id: string) => post<{ scene: SceneDTO }>(`/scenes/${id}/retry`),
    (tour, id) => mapScene(tour, id, (s) => ({ ...s, status: 'queued', progress: 0, error: null })),
  );
}

export function useReorderScenes(tourId: string) {
  return useTourMutation(
    tourId,
    (sceneIds: string[]) => put<{ tour: TourDTO }>(`/tours/${tourId}/scenes/order`, { sceneIds }),
    (tour, sceneIds) => ({
      ...tour,
      scenes: sceneIds
        .map((id, position) => {
          const s = tour.scenes.find((x) => x.id === id);
          return s && { ...s, position };
        })
        .filter((s): s is SceneDTO => !!s),
    }),
  );
}

export function useCreateHotspot(tourId: string) {
  return useTourMutation(
    tourId,
    async ({ sceneId, ...input }: CreateHotspotInput & { sceneId: string }) =>
      (await post<{ hotspot: HotspotDTO }>(`/scenes/${sceneId}/hotspots`, input)).hotspot,
    (tour) => tour,
    (hotspot, qc) =>
      qc.setQueryData<TourDTO>(tourKey(tourId), (tour) =>
        tour
          ? mapScene(tour, hotspot.sceneId, (s) => ({ ...s, hotspots: [...s.hotspots, hotspot] }))
          : tour,
      ),
  );
}

export function useUpdateHotspot(tourId: string) {
  return useTourMutation(
    tourId,
    ({ id, ...input }: UpdateHotspotInput & { id: string }) =>
      patch<{ hotspot: HotspotDTO }>(`/hotspots/${id}`, input),
    (tour, { id, ...input }) =>
      mapHotspots(tour, (hs) => hs.map((h) => (h.id === id ? { ...h, ...input } : h))),
  );
}

export function useDeleteHotspot(tourId: string) {
  return useTourMutation(
    tourId,
    (id: string) => del(`/hotspots/${id}`),
    (tour, id) => mapHotspots(tour, (hs) => hs.filter((h) => h.id !== id)),
  );
}
