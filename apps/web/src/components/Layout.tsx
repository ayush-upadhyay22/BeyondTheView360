import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { BRAND } from '../config';
import { useLogout, useMe } from '../lib/auth';

export function Logo({
  className = '',
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  return (
    <Link
      to="/"
      className={`flex shrink-0 items-center gap-2 font-semibold tracking-tight ${className}`}
      aria-label={compact ? BRAND.name : undefined}
    >
      <img src="/favicon.svg" alt="" width={28} height={28} />
      {!compact && <span>{BRAND.name}</span>}
    </Link>
  );
}

export function AppHeader({ children }: { children?: ReactNode }) {
  const me = useMe();
  const logout = useLogout();
  const navigate = useNavigate();
  return (
    <header className="sticky top-0 z-20 border-b border-ink-700 bg-ink-950/85 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4">
        <Logo />
        <div className="flex min-w-0 flex-1 items-center gap-3">{children}</div>
        <nav className="flex items-center gap-2 text-sm">
          {me.data ? (
            <>
              <Link to="/app" className="btn-ghost">
                My tours
              </Link>
              <span className="hidden text-slate-500 md:inline">{me.data.email}</span>
              <button
                type="button"
                className="btn-ghost"
                onClick={() => logout.mutate(undefined, { onSuccess: () => navigate('/') })}
              >
                Log out
              </button>
            </>
          ) : (
            <>
              <Link to="/login" className="btn-ghost">
                Log in
              </Link>
              <Link to="/signup" className="btn-primary">
                Get started
              </Link>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}

export function PageShell({ children, header }: { children: ReactNode; header?: ReactNode }) {
  return (
    <div className="flex min-h-full flex-col">
      <AppHeader>{header}</AppHeader>
      <main className="flex-1">{children}</main>
    </div>
  );
}
