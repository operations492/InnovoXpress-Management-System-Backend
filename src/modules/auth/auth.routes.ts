import { Router } from 'express';
import * as controller from './auth.controller.js';
import { authenticate } from '../../middleware/auth.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { validate } from '../../middleware/validate.js';
import { pushTokenSchema } from '../../schemas/push.schema.js';

const router = Router();

/**
 * There is no POST /login.
 *
 * Clients sign in against Supabase Auth directly — `supabase.auth
 * .signInWithPassword(...)` — which hands them a token this API accepts AND
 * Postgres understands for row-level security. Proxying it through here would
 * add a hop, lose automatic token refresh, and give us a second thing to keep
 * correct.
 */
router.get('/me', authenticate, asyncHandler(controller.me));

/**
 * Where to push notifications for whoever is signed in.
 *
 * Deliberately keyed off the TOKEN rather than taking a user id: a caller must
 * never be able to redirect somebody else's notifications to their own phone by
 * posting an id that is not theirs.
 */
router.post(
  '/push-token',
  authenticate,
  validate(pushTokenSchema),
  asyncHandler(controller.setPushToken),
);

export default router;
