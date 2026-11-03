import { extname } from 'node:path';
import { Router, type Request } from 'express';
import multer from 'multer';
import { DatabaseStorageDriver } from '@btv/core';
import { ALLOWED_UPLOAD_TYPES, FLOOR_PLAN_CONTENT_TYPE } from '@btv/shared';
import { badRequest, notFound } from '../errors.js';
import { ah } from '../middleware.js';

const TYPES: Record<string, string> = {
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

const ACCEPT = new Set<string>([...ALLOWED_UPLOAD_TYPES, FLOOR_PLAN_CONTENT_TYPE]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024, files: 1 },
});

function field(req: Request, name: string): string {
  const raw = req.body?.[name];
  return typeof raw === 'string' ? raw : '';
}

/** Browser POSTs the file here (same shape as an S3 presign). GET serves processed images. */
export function databaseStorageRouter(storage: DatabaseStorageDriver): Router {
  const router = Router();

  router.post(
    '/storage/upload',
    upload.single('file'),
    ah(async (req, res) => {
      const key = field(req, 'key');
      const token = field(req, 'token');
      const file = req.file;
      if (!key || !token || !file) throw badRequest('Upload form is missing key, token or file.');
      const problem = storage.verifyUploadToken(key, token, file.size);
      if (problem) throw badRequest(problem);
      const type = file.mimetype || field(req, 'Content-Type');
      if (type && !ACCEPT.has(type)) throw badRequest('Only JPEG, PNG and WebP images are supported.');
      await storage.put(key, file.buffer, { contentType: type || 'application/octet-stream' });
      res.status(204).end();
    }),
  );

  router.get(
    '/media/{*key}',
    ah(async (req, res) => {
      const raw = req.params.key;
      const key = Array.isArray(raw) ? raw.join('/') : raw;
      if (!key) throw notFound('File');
      const info = await storage.head(key);
      if (!info) throw notFound('File');
      const body = await storage.get(key);
      res.setHeader('Content-Type', info.contentType ?? TYPES[extname(key).toLowerCase()] ?? 'application/octet-stream');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('Content-Length', String(body.length));
      res.end(body);
    }),
  );

  return router;
}
