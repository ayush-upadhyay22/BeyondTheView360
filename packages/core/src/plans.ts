import type { PlanLimits } from '@btv/shared';

const MB = 1024 * 1024;

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Plan catalogue. Values can be tuned with PLAN_<PLAN>_* environment variables.
 *
 * EXTENSION POINT (payments): add paid plans here (e.g. "pro") and have the billing webhook
 * update `users.plan`. Nothing else needs to change — every limit check goes through
 * `limitsForPlan`.
 */
export function getPlans(): Record<string, PlanLimits> {
  return {
    free: {
      maxTours: intFromEnv('PLAN_FREE_MAX_TOURS', 3),
      maxScenesPerTour: intFromEnv('PLAN_FREE_MAX_SCENES_PER_TOUR', 20),
      maxUploadBytes: intFromEnv('PLAN_FREE_MAX_UPLOAD_MB', 100) * MB,
    },
  };
}

export const DEFAULT_PLAN = 'free';

export function limitsForPlan(plan: string): PlanLimits {
  const plans = getPlans();
  return plans[plan] ?? (plans[DEFAULT_PLAN] as PlanLimits);
}
