import { createHash } from 'node:crypto';
import { access, appendFile, copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { DatabaseStorageDriver } from '@btv/core';
import { ALLOWED_UPLOAD_TYPES, FLOOR_PLAN_CONTENT_TYPE, UPLOAD_CHUNK_BYTES } from '@btv/shared';
import { badRequest, conflict, HttpError, notFound } from '../errors.js';
import { ah } from '../middleware.js';

const TYPES: Record<string, string> = {
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

const ACCEPT = new Set<string>([...ALLOWED_UPLOAD_TYPES, FLOOR_PLAN_CONTENT_TYPE]);
const MAX_CHUNKS = 32;
const MAX_FILE_BYTES = 100 * 1024 * 1024;

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, tmpdir()),
    filename: (_req, _file, cb) =>
      cb(null, `btv-${Date.now()}-${Math.random().toString(36).slice(2)}`),
  }),
  limits: { fileSize: MAX_FILE_BYTES, files: 1 },
});

function field(req: Request, name: string): string {
  const raw = req.body?.[name];
  return typeof raw === 'string' ? raw : '';
}

function intField(req: Request, name: string): number | null {
  const raw = field(req, name);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) ? n : null;
}

function sessionDir(token: string): string {
  const id = createHash('sha256').update(token).digest('hex').slice(0, 32);
  return join(tmpdir(), 'btv-uploads', id);
}

async function unlinkQuiet(path: string | undefined): Promise<void> {
  if (!path) return;
  await rm(path, { force: true }).catch(() => undefined);
}

function receiveFile(req: Request, res: Response, next: NextFunction): void {
  upload.single('file')(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        next(
          new HttpError(413, 'file_too_large', 'This file is larger than the 100 MB upload limit.'),
        );
        return;
      }
      next(badRequest('The upload could not be read. Please try again.'));
      return;
    }
    next(err);
  });
}

/** Browser POSTs the file here (same shape as an S3 presign). GET serves processed images. */
export function databaseStorageRouter(storage: DatabaseStorageDriver): Router {
  const router = Router();

  router.post(
    '/storage/upload',
    (req, _res, next) => {
      req.setTimeout(5 * 60_000);
      next();
    },
    receiveFile,
    ah(async (req, res) => {
      const tmp = req.file?.path;
      try {
        const key = field(req, 'key');
        const token = field(req, 'token');
        const file = req.file;
        if (!key || !token || !file) throw badRequest('Upload form is missing key, token or file.');

        const chunkIndex = intField(req, 'chunkIndex');
        const chunkTotal = intField(req, 'chunkTotal');
        const chunked = chunkIndex !== null || chunkTotal !== null;
        if (chunked) {
          if (
            chunkIndex === null ||
            chunkTotal === null ||
            chunkTotal < 1 ||
            chunkTotal > MAX_CHUNKS ||
            chunkIndex < 0 ||
            chunkIndex >= chunkTotal
          ) {
            throw badRequest('Invalid upload chunk.');
          }
          if (file.size > UPLOAD_CHUNK_BYTES + 64 * 1024) {
            throw badRequest('Upload chunk is too large.');
          }
        }

        const declared = Number(field(req, 'size') || file.size);
        const problem = storage.verifyUploadToken(
          key,
          token,
          Number.isFinite(declared) && declared > 0 ? declared : file.size,
        );
        if (problem) throw badRequest(problem);

        const type = file.mimetype || field(req, 'Content-Type');
        if (type && !ACCEPT.has(type)) {
          throw badRequest('Only JPEG, PNG and WebP images are supported.');
        }

        if (!chunked || chunkIndex === null || chunkTotal === null) {
          const body = await readFile(file.path);
          await storage.put(key, body, { contentType: type || 'application/octet-stream' });
          res.status(204).end();
          return;
        }

        const index = chunkIndex;
        const total = chunkTotal;
        const dir = sessionDir(token);
        if (index === 0) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
        await mkdir(dir, { recursive: true });
        if (index > 0) {
          try {
            await access(join(dir, '0'));
          } catch {
            throw conflict(
              'upload_restart',
              'The upload session expired. The browser will restart it.',
            );
          }
        }
        await copyFile(file.path, join(dir, String(index)));

        if (index !== total - 1) {
          res.status(204).end();
          return;
        }

        const assembled = join(dir, 'complete');
        await rm(assembled, { force: true }).catch(() => undefined);
        let size = 0;
        for (let i = 0; i < total; i++) {
          const part = await readFile(join(dir, String(i)));
          size += part.length;
          await appendFile(assembled, part);
        }
        const finalProblem = storage.verifyUploadToken(key, token, size);
        if (finalProblem) throw badRequest(finalProblem);
        const body = await readFile(assembled);
        await storage.put(key, body, { contentType: type || 'application/octet-stream' });
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
        res.status(204).end();
      } finally {
        await unlinkQuiet(tmp);
      }
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
      res.setHeader(
        'Content-Type',
        info.contentType ?? TYPES[extname(key).toLowerCase()] ?? 'application/octet-stream',
      );
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('Content-Length', String(body.length));
      res.end(body);
    }),
  );

  return router;
}
