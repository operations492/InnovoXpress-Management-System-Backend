import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../../utils/httpError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import * as repo from './chat.repository.js';

/**
 * Resource-based authorization for chat, in the same spirit as
 * `middleware/ownership.ts`.
 *
 * `requireMinRole('operator')` answers "are you staff?". It cannot answer "is
 * this conversation yours?" — and that is the only question that matters
 * here. Without this guard any operator could read every private DM in the
 * company by changing the id in the URL.
 *
 * Unlike consignments, there is no "dispatchers see everything" exemption:
 * an admin is not a member of a DM they were not part of, and must not be
 * able to read it.
 */
export const requireConversationMember = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    const user = req.user;
    if (!user) throw AppError.unauthorized();

    const id = (req.params as unknown as { id?: string }).id;
    if (!id) throw AppError.badRequest('Missing conversation id');

    const membership = await repo.findMembership(id, user.id);

    // Identical response whether the conversation does not exist or simply
    // is not theirs. A 404 for one and 403 for the other would let anyone
    // probe which conversation ids are real by watching the status code —
    // the same reasoning as allowOperatorOrAssignedDriver.
    if (!membership) {
      throw AppError.forbidden('You are not a member of this conversation');
    }

    // Stashed so the controller does not re-query what the guard just read.
    req.chatMembership = membership;

    return next();
  },
);
