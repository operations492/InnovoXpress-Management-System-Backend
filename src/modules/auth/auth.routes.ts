import { Router } from 'express';
import * as controller from './auth.controller.js';
import { authenticate } from '../../middleware/auth.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { validate } from '../../middleware/validate.js';
import { uploadAvatarFile } from '../../middleware/upload.js';
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

/**
 * This person's own profile photo.
 *
 * Under `/auth` rather than `/users` for the same reason as `/push-token`: it is
 * scoped to whoever holds the token, and `/users` is admin-only. A driver must
 * be able to change their own picture without being able to touch anybody
 * else's — which is exactly what taking the id from the token and never from the
 * request buys.
 */
router.post('/avatar', authenticate, uploadAvatarFile, asyncHandler(controller.setAvatar));
router.delete('/avatar', authenticate, asyncHandler(controller.removeAvatar));

export default router;
