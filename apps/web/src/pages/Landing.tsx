import { Link } from 'react-router-dom';
import { BRAND } from '../config';
import { PageShell } from '../components/Layout';
import { CompassIcon, GogglesIcon, ImagesIcon, LinkIcon, UploadIcon } from '../components/icons';
import { useMe } from '../lib/auth';

const FEATURES = [
  {
    icon: <UploadIcon />,
    title: 'Drop in your panoramas',
    text: 'Drag 360° photos from any camera. They upload straight to secure storage and are optimised for every screen automatically.',
  },
  {
    icon: <LinkIcon />,
    title: 'Connect rooms with a click',
    text: 'Place hotspots right inside the panorama to walk between scenes or reveal notes, photos and details.',
  },
  {
    icon: <CompassIcon />,
    title: 'Set the first impression',
    text: 'Choose where every scene starts and which way is north, so visitors always arrive facing the right way.',
  },
  {
    icon: <GogglesIcon />,
    title: 'Look around any way',
    text: 'Drag, pinch, scroll, use the keyboard, tilt your phone or slip it into a cardboard headset.',
  },
  {
    icon: <ImagesIcon />,
    title: 'Share or embed',
    text: 'Send a link or paste one line of HTML to put the tour on your own website.',
  },
];

export function Landing() {
  const me = useMe();
  return (
    <PageShell>
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_top,rgba(56,189,248,0.18),transparent_60%),radial-gradient(ellipse_at_bottom_right,rgba(245,158,11,0.12),transparent_55%)]" />
        <div className="mx-auto max-w-5xl px-4 pb-16 pt-20 text-center sm:pt-28">
          <p className="mb-4 inline-block rounded-full border border-brand-400/30 bg-brand-400/10 px-3 py-1 text-xs font-medium text-brand-300">
            360° virtual tours, made simple
          </p>
          <h1 className="text-4xl font-bold tracking-tight sm:text-6xl">
            {BRAND.tagline}
            <span className="block bg-gradient-to-r from-brand-300 to-ember-400 bg-clip-text text-transparent">
              Share it in minutes.
            </span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-slate-300">{BRAND.description}</p>
          <div className="mt-10 flex flex-wrap justify-center gap-3">
            <Link to={me.data ? '/app' : '/signup'} className="btn-primary px-6 py-3 text-base">
              {me.data ? 'Open my tours' : 'Create your first tour'}
            </Link>
            <Link to="/demo" className="btn-secondary px-6 py-3 text-base">
              Try the live viewer
            </Link>
          </div>
        </div>
      </section>

      <section className="mx-auto grid max-w-6xl gap-4 px-4 pb-24 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((f) => (
          <article key={f.title} className="card p-6">
            <div className="mb-3 grid h-10 w-10 place-items-center rounded-lg bg-brand-500/15 text-brand-300">
              {f.icon}
            </div>
            <h2 className="mb-1 font-semibold">{f.title}</h2>
            <p className="text-sm leading-relaxed text-slate-400">{f.text}</p>
          </article>
        ))}
      </section>

      <footer className="border-t border-ink-800 py-8 text-center text-xs text-slate-500">
        © {new Date().getFullYear()} {BRAND.name}
      </footer>
    </PageShell>
  );
}
