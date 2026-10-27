import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';
import { Landing } from './pages/Landing';
import { NotFound } from './pages/NotFound';
import { FullPageSpinner } from './components/feedback';
import { RequireAuth } from './lib/auth';

// Route-level code splitting; the viewer pages pull in Three.js.
const Demo = lazy(() => import('./pages/Demo'));
const Login = lazy(() => import('./pages/Auth').then((m) => ({ default: m.Login })));
const Signup = lazy(() => import('./pages/Auth').then((m) => ({ default: m.Signup })));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const TourEditor = lazy(() => import('./pages/TourEditor'));
const PublicTour = lazy(() => import('./pages/PublicTour'));
const EmbedTour = lazy(() => import('./pages/EmbedTour'));

export function App() {
  return (
    <Suspense fallback={<FullPageSpinner />}>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/demo" element={<Demo />} />
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />
        <Route
          path="/app"
          element={
            <RequireAuth>
              <Dashboard />
            </RequireAuth>
          }
        />
        <Route
          path="/app/tours/:tourId"
          element={
            <RequireAuth>
              <TourEditor />
            </RequireAuth>
          }
        />
        <Route path="/t/:shareId" element={<PublicTour />} />
        <Route path="/embed/:shareId" element={<EmbedTour />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Suspense>
  );
}
