import { Link } from 'react-router-dom';
import { PageShell } from '../components/Layout';

export function NotFound({
  title = 'This view does not exist',
  message = 'The page you are looking for may have moved, been deleted, or never existed.',
}: {
  title?: string;
  message?: string;
}) {
  return (
    <PageShell>
      <div className="mx-auto flex max-w-lg flex-col items-center px-4 py-24 text-center">
        <p className="mb-2 font-mono text-6xl font-bold text-brand-400/80">404</p>
        <h1 className="mb-2 text-2xl font-semibold">{title}</h1>
        <p className="mb-8 text-slate-400">{message}</p>
        <Link to="/" className="btn-primary">
          Back to the start
        </Link>
      </div>
    </PageShell>
  );
}
