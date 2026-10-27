import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { BRAND } from '../config';
import { Logo } from '../components/Layout';
import { FullPageSpinner, InlineError } from '../components/feedback';
import { errorMessage } from '../lib/api';
import { useLogin, useMe, useSignup } from '../lib/auth';

/** Only allow same-app relative redirects (prevents open redirects via ?next=). */
function safeNext(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/app';
}

function AuthCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center px-4 py-12">
      <Logo className="mb-8 text-lg" />
      <div className="card w-full max-w-sm p-6 sm:p-8">
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="mb-6 mt-1 text-sm text-slate-400">{subtitle}</p>
        {children}
      </div>
    </div>
  );
}

function useAuthForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  return { email, setEmail, password, setPassword };
}

export function Login() {
  const me = useMe();
  const login = useLogin();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const f = useAuthForm();

  if (me.isPending) return <FullPageSpinner />;
  if (me.data) return <Navigate to={next} replace />;

  function submit(e: FormEvent) {
    e.preventDefault();
    login.mutate(
      { email: f.email, password: f.password },
      { onSuccess: () => navigate(next, { replace: true }) },
    );
  }

  return (
    <AuthCard
      title="Welcome back"
      subtitle={
        <>
          New to {BRAND.name}?{' '}
          <Link className="text-brand-300 hover:underline" to="/signup">
            Create an account
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        <div>
          <label className="label" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            className="input"
            type="email"
            autoComplete="email"
            required
            value={f.email}
            onChange={(e) => f.setEmail(e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            className="input"
            type="password"
            autoComplete="current-password"
            required
            value={f.password}
            onChange={(e) => f.setPassword(e.target.value)}
          />
        </div>
        <InlineError>{login.isError && errorMessage(login.error)}</InlineError>
        <button type="submit" className="btn-primary w-full" disabled={login.isPending}>
          {login.isPending ? 'Signing in…' : 'Log in'}
        </button>
      </form>
    </AuthCard>
  );
}

export function Signup() {
  const me = useMe();
  const signup = useSignup();
  const navigate = useNavigate();
  const f = useAuthForm();
  const [touched, setTouched] = useState(false);

  if (me.isPending) return <FullPageSpinner />;
  if (me.data) return <Navigate to="/app" replace />;

  const tooShort = f.password.length < 10;

  function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (tooShort) return;
    signup.mutate(
      { email: f.email, password: f.password },
      { onSuccess: () => navigate('/app', { replace: true }) },
    );
  }

  return (
    <AuthCard
      title="Create your account"
      subtitle={
        <>
          Already have one?{' '}
          <Link className="text-brand-300 hover:underline" to="/login">
            Log in
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        <div>
          <label className="label" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            className="input"
            type="email"
            autoComplete="email"
            required
            value={f.email}
            onChange={(e) => f.setEmail(e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            className="input"
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
            aria-describedby="password-hint"
            value={f.password}
            onChange={(e) => f.setPassword(e.target.value)}
          />
          <p
            id="password-hint"
            className={`mt-1 text-xs ${touched && tooShort ? 'text-red-300' : 'text-slate-500'}`}
          >
            At least 10 characters. A short sentence works well.
          </p>
        </div>
        <InlineError>{signup.isError && errorMessage(signup.error)}</InlineError>
        <button type="submit" className="btn-primary w-full" disabled={signup.isPending}>
          {signup.isPending ? 'Creating account…' : 'Create account'}
        </button>
      </form>
    </AuthCard>
  );
}
