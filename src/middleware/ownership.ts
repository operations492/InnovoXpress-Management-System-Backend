import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/prisma.js';
import { AppError } from '../utils/httpError.js';
import { asyncHandler } from '../utils/asyncHandler.js';

/**
 * Resource-based authorization, as distinct from role-based.
 *
 * `requireMinRole` answers "what kind of caller are you?". It cannot answer "is
 * this particular order yours?" — and for a driver that is the question that
 * matters. Without this, any driver could mark any order delivered or upload
 * proof against someone else's job simply by changing the id in the URL.
 *
 * Console users (operator and above) are dispatchers: they legitimately act on
 * every order, so they pass straight through. A driver token must own the row.
 */
export const allowOperatorOrAssignedDriver = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    const user = req.user;
    if (!user) throw AppError.unauthorized();

    // Dispatchers see the whole book of work by design.
    if (user.role !== 'driver') return next();

    const driverId = user.driverId;
    if (!driverId) throw AppError.forbidden('This driver token is not linked to a driver');

    const id = (req.params as unknown as { id?: string }).id;
    if (!id) throw AppError.badRequest('Missing consignment id');

    const consignment = await prisma.consignment.findUnique({
      where: { id },
      select: { driverId: true },
    });

    // Identical response whether the order does not exist or simply is not
    // theirs. Returning 404 for one and 403 for the other would let a driver
    // probe which order ids are real by watching the status code.
    if (!consignment || consignment.driverId !== driverId) {
      throw AppError.forbidden('This consignment is not assigned to you');
    }

    return next();
  },
);
