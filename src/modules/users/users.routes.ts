import { Router } from 'express';
import * as controller from './users.controller.js';
import { authenticate } from '../../middleware/auth.js';
import { requireMinRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import {
  createUserSchema,
  updateUserSchema,
  userIdParamSchema,
  usersQuerySchema,
} from '../../schemas/user.schema.js';

/**
 * User administration — admin only, every route.
 *
 * This is the one part of the API that can create the credentials to reach the
 * rest of it, so there is no operator-level read here: an operator cannot even
 * list who exists.
 */
const router = Router();

router.use(authenticate, requireMinRole('admin'));

// Before /:id, or "unlinked-drivers" is read as an id.
router.get('/unlinked-drivers', asyncHandler(controller.unlinkedDrivers));

router.get('/', validate(usersQuerySchema, 'query'), asyncHandler(controller.list));
router.post('/', validate(createUserSchema), asyncHandler(controller.create));

router.get('/:id', validate(userIdParamSchema, 'params'), asyncHandler(controller.get));

router.patch(
  '/:id',
  validate(userIdParamSchema, 'params'),
  validate(updateUserSchema),
  asyncHandler(controller.update),
);

router.delete('/:id', validate(userIdParamSchema, 'params'), asyncHandler(controller.remove));

/** Remove a courier from the roster entirely — only if they have no history. */
router.delete(
  '/drivers/:id',
  validate(userIdParamSchema, 'params'),
  asyncHandler(controller.removeDriver),
);

export default router;
