import type { ReactNode } from 'react';

export function Spinner({ size = 24, label = 'Loading' }: { size?: number; label?: string }) {
  return (
    <span role="status" aria-label={label} className="inline-block">
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        className="animate-spin text-brand-400"
        aria-hidden="true"
      >
        <circle
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="3"
          fill="none"
          opacity="0.2"
        />
        <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" fill="none" />
      </svg>
    </span>
  );
}

export function FullPageSpinner() {
  return (
    <div className="grid h-full min-h-[50vh] place-items-center">
      <Spinner size={32} />
    </div>
  );
}

export function ErrorState({
  title = 'Something went wrong',
  message,
  action,
}: {
  title?: string;
  message: string;
  action?: ReactNode;
}) {
  return (
    <div
      role="alert"
      className="mx-auto max-w-md rounded-2xl border border-red-500/30 bg-red-500/5 p-6 text-center"
    >
      <h2 className="mb-1 font-semibold text-red-200">{title}</h2>
      <p className="text-sm text-red-200/80">{message}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  message,
  action,
}: {
  icon?: ReactNode;
  title: string;
  message: string;
  action?: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-md rounded-2xl border border-dashed border-ink-600 p-10 text-center">
      {icon && <div className="mb-3 flex justify-center text-brand-300">{icon}</div>}
      <h2 className="mb-1 text-lg font-semibold">{title}</h2>
      <p className="text-sm text-slate-400">{message}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function InlineError({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="text-sm text-red-300">
      {children}
    </p>
  );
}
