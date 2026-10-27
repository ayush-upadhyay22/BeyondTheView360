import type { ErrorRequestHandler } from 'express';
import type { ApiErrorBody } from '@btv/shared';
import type { Logger } from '@btv/core';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Please log in to continue.') =>
  new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'You are not allowed to do that.') =>
  new HttpError(403, 'forbidden', message);
/** Also used for resources owned by someone else, so their existence is not revealed. */
export const notFound = (what = 'Resource') =>
  new HttpError(404, 'not_found', `${what} not found.`);
export const conflict = (code: string, message: string) => new HttpError(409, code, message);
export const limitReached = (message: string) => new HttpError(402, 'plan_limit', message);

export function errorBody(code: string, message: string, details?: unknown): ApiErrorBody {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

interface BodyParserError extends Error {
  type?: string;
  status?: number;
}

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err: unknown, req, res, _next) => {
    if (err instanceof HttpError) {
      res.status(err.status).json(errorBody(err.code, err.message, err.details));
      return;
    }
    const e = err as BodyParserError;
    if (e?.type === 'entity.too.large') {
      res.status(413).json(errorBody('payload_too_large', 'Request body is too large.'));
      return;
    }
    if (e?.type === 'entity.parse.failed') {
      res.status(400).json(errorBody('invalid_json', 'Request body is not valid JSON.'));
      return;
    }
    (req.log ?? logger).error({ err }, 'unhandled error');
    res.status(500).json(errorBody('internal', 'Something went wrong. Please try again.'));
  };
}
