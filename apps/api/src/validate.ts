import type { z } from 'zod';
import { badRequest } from './errors.js';

/** Validates untrusted input; throws a 400 with field-level details on failure. */
export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const fields = result.error.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
    }));
    const first = fields[0];
    const summary = first ? `${first.path ? `${first.path}: ` : ''}${first.message}` : 'Invalid';
    throw badRequest(`Invalid request — ${summary}`, { fields });
  }
  return result.data;
}
