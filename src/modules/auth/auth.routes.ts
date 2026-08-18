import { Router } from 'express';
import * as controller from './auth.controller.js';
import { authenticate } from '../../middleware/auth.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

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

export default router;
