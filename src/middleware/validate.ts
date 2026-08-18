import type { Request, Response, NextFunction } from 'express';
import type { ZodSchema } from 'zod';
import { AppError } from '../utils/httpError.js';

type Source = 'body' | 'query' | 'params';

/**
 * Validate a request part against a Zod schema. On success, replaces the part
 * with the parsed (typed/coerced) value. On failure, throws a 400 with details.
 */
export function validate(schema: ZodSchema, source: Source = 'body') {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      return next(
        AppError.badRequest('Validation failed', result.error.flatten().fieldErrors),
      );
    }
    // express 5: req.query has only a getter — assign validated copy elsewhere.
    if (source === 'query') {
      (req as Request & { validatedQuery?: unknown }).validatedQuery = result.data;
    } else {
      req[source] = result.data;
    }
    next();
  };
}

/** Read the validated query produced by validate(schema, 'query'). */
export function getValidatedQuery<T>(req: Request): T {
  return (req as Request & { validatedQuery: T }).validatedQuery;
}
