import { useMemo } from 'react';
import { useTourStats } from '../lib/queries';

const DAYS = 30;

/** Aggregated daily view counts for the last 30 days (no per-visitor data exists). */
export function ViewStats({ tourId }: { tourId: string }) {
  const stats = useTourStats(tourId);

  const series = useMemo(() => {
    const byDay = new Map((stats.data?.daily ?? []).map((d) => [d.day, d.count]));
    const today = new Date();
    return Array.from({ length: DAYS }, (_, i) => {
      const d = new Date(today);
      d.setUTCDate(today.getUTCDate() - (DAYS - 1 - i));
      const day = d.toISOString().slice(0, 10);
      return { day, count: byDay.get(day) ?? 0 };
    });
  }, [stats.data]);

  const max = Math.max(1, ...series.map((s) => s.count));
  const last30 = series.reduce((sum, s) => sum + s.count, 0);

  return (
    <section aria-labelledby="views-heading" className="space-y-2">
      <h2 id="views-heading" className="font-semibold">
        Views
      </h2>
      {stats.isPending ? (
        <div className="skeleton h-16" />
      ) : stats.isError ? (
        <p className="text-xs text-slate-500">Stats are unavailable right now.</p>
      ) : (
        <>
          <p className="text-sm">
            <span className="text-2xl font-semibold">{stats.data.total.toLocaleString()}</span>{' '}
            <span className="text-slate-400">total · {last30.toLocaleString()} in 30 days</span>
          </p>
          <div
            className="flex h-12 items-end gap-px"
            role="img"
            aria-label={`Daily views over the last ${DAYS} days, peak ${max}`}
          >
            {series.map((s) => (
              <div
                key={s.day}
                title={`${s.day}: ${s.count}`}
                className="flex-1 rounded-sm bg-brand-400/70"
                style={{
                  height: `${Math.max(4, (s.count / max) * 100)}%`,
                  opacity: s.count ? 1 : 0.25,
                }}
              />
            ))}
          </div>
          <p className="text-xs text-slate-500">
            Counted once per browser session. No cookies or personal data are stored.
          </p>
        </>
      )}
    </section>
  );
}
