import type { Request, Response, NextFunction, RequestHandler } from 'express';

/** Wrap an async controller so thrown errors reach the central error handler. */
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };
