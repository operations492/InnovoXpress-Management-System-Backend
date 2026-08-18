import { Router } from 'express';
import * as controller from './map.controller.js';
import { authenticate } from '../../middleware/auth.js';
import { requireMinRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { mapDriversQuerySchema, mapPinsQuerySchema } from '../../schemas/map.schema.js';

const router = Router();

/*
 * Operator and above, always.
 *
 * `/pins` returns every open task's receiver address in one unpaginated
 * response, which makes it the highest-value read in the API — so the role gate
 * is not optional and a driver token fails it by construction.
 *
 * The map is read-only: View, Edit and Assign Driver all use the existing
 * consignments endpoints, so there is nothing to write here.
 */
router.use(authenticate, requireMinRole('operator'));

router.get('/pins', validate(mapPinsQuerySchema, 'query'), asyncHandler(controller.pins));

router.get(
  '/drivers',
  validate(mapDriversQuerySchema, 'query'),
  asyncHandler(controller.drivers),
);

export default router;
