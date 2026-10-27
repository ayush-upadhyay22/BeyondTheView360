import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Mirrors the production framing policy in dev: only /embed/* may be framed by other sites.
 * (The full CSP is applied by server/serve.ts in production; Vite's HMR needs inline scripts.)
 */
function framingHeaders(): Plugin {
  return {
    name: 'btv-framing-headers',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith('/embed/')) {
          res.setHeader('Content-Security-Policy', 'frame-ancestors *');
        } else {
          res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
          res.setHeader('X-Frame-Options', 'SAMEORIGIN');
        }
        next();
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.VITE_API_PROXY_TARGET || 'http://localhost:4000';
  return {
    plugins: [react(), framingHeaders()],
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': { target, changeOrigin: false, xfwd: true },
      },
    },
    preview: { port: 4173 },
    build: {
      target: 'es2022',
      sourcemap: true,
      rollupOptions: {
        output: {
          manualChunks: { three: ['three'], react: ['react', 'react-dom', 'react-router-dom'] },
        },
      },
    },
  };
});
