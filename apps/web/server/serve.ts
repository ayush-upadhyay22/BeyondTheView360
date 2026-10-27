/**
 * Production server for the built SPA (apps/web/dist).
 * - strict Content-Security-Policy on every page
 * - only /embed/* may be framed by other sites (EMBED_FRAME_ANCESTORS)
 * - long-lived caching for hashed assets, no-cache for index.html
 * - optional /api reverse proxy (API_PROXY_TARGET) for setups without a load balancer
 */
import { existsSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type RequestHandler } from 'express';
import helmet from 'helmet';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, '../dist');
const indexHtml = resolve(dist, 'index.html');

const list = (value: string | undefined) =>
  (value ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

const port = Number(process.env.WEB_PORT ?? process.env.PORT ?? 8080);
const mediaOrigins = list(process.env.CSP_MEDIA_ORIGINS);
const embedAncestors = list(process.env.EMBED_FRAME_ANCESTORS ?? '*');
const apiTarget = process.env.API_PROXY_TARGET?.trim();

if (!existsSync(indexHtml)) {
  console.error(`Build not found at ${dist}. Run "npm run build -w @btv/web" first.`);
  process.exit(1);
}

function securityHeaders(frameAncestors: string[], embeddable: boolean): RequestHandler {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // React writes inline style attributes (hotspot positions); no inline <style>/<script>.
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:', ...mediaOrigins],
        connectSrc: ["'self'", ...mediaOrigins],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors,
        upgradeInsecureRequests: null,
      },
    },
    // X-Frame-Options cannot express an allowlist; CSP frame-ancestors is authoritative.
    frameguard: embeddable ? false : { action: 'sameorigin' },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  });
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

if (apiTarget) {
  const target = new URL(apiTarget);
  const client = target.protocol === 'https:' ? https : http;
  app.use('/api', (req, res) => {
    const upstream = client.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        method: req.method,
        path: `/api${req.url}`,
        headers: {
          ...req.headers,
          host: target.host,
          'x-forwarded-host': req.headers.host ?? '',
          'x-forwarded-proto': req.protocol,
          'x-forwarded-for': req.ip ?? '',
        },
      },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent)
        res.status(502).json({ error: { code: 'bad_gateway', message: 'API unavailable' } });
    });
    req.pipe(upstream);
  });
}

app.use(
  '/assets',
  express.static(resolve(dist, 'assets'), { immutable: true, maxAge: '1y', index: false }),
);
app.use(express.static(dist, { index: false, maxAge: '1h' }));

const embedHeaders = securityHeaders(embedAncestors, true);
const appHeaders = securityHeaders(["'self'"], false);
app.get('/{*path}', (req, res, next) => {
  const headers = req.path.startsWith('/embed/') ? embedHeaders : appHeaders;
  headers(req, res, () => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(indexHtml, (err) => err && next(err));
  });
});

app.listen(port, () => {
  console.info(`Web app listening on http://localhost:${port}`);
});
