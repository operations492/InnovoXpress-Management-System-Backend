import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/httpError.js';

export function notFound(req: Request, _res: Response, next: NextFunction) {
  next(AppError.notFound(`Route not found: ${req.method} ${req.path}`));
}
