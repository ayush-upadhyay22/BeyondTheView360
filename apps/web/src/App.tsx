import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';
import { Landing } from './pages/Landing';
import { NotFound } from './pages/NotFound';
import { FullPageSpinner } from './components/feedback';

// The viewer pulls in Three.js; keep it out of the landing bundle.
const Demo = lazy(() => import('./pages/Demo'));

export function App() {
  return (
    <Suspense fallback={<FullPageSpinner />}>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/demo" element={<Demo />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Suspense>
  );
}
