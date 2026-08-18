import type { Request, Response, NextFunction } from 'express';
import type { UserRole } from '@prisma/client';
import { AppError } from '../utils/httpError.js';

/**
 * What kind of caller is this?
 *
 * Ranked, so a check reads as "operator or above" rather than listing every
 * role that qualifies. The previous `requireRole(...roles)` had no hierarchy —
 * `requireRole('operator')` rejected an admin — which is why every call site
 * ended up listing all roles and therefore enforcing nothing.
 */
const ROLE_RANK: Record<UserRole, number> = {
  // Rank 0: a driver must never satisfy a console permission. They can report
  // their own position and close their own jobs, nothing else.
  driver: 0,
  operator: 1,
  admin: 2,
};

/**
 * Note this takes the caller's role from OUR profile row, never from the
 * token's own `role` claim — that claim is always the literal string
 * `authenticated` (it is the Postgres role Supabase uses for RLS) and would
 * score `undefined ?? 0`, silently locking every console route.
 */
export function requireMinRole(min: UserRole) {
  const threshold = ROLE_RANK[min];

  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(AppError.unauthorized());
    if (ROLE_RANK[req.user.role] >= threshold) return next();
    return next(AppError.forbidden(`Requires ${min} role or higher`));
  };
}

/** The inverse: this endpoint belongs to the driver app. */
export function requireDriver(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(AppError.unauthorized());
  if (req.user.role !== 'driver' || !req.user.driverId) {
    return next(AppError.forbidden('This endpoint is for the driver app'));
  }
  return next();
}
