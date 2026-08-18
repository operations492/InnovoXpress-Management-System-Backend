import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requireMinRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import {
  createRouteSchema,
  driverIdParamSchema,
  reorderRouteSchema,
  routeIdParamSchema,
} from '../../schemas/route.schema.js';
import * as controller from './routes.controller.js';

/**
 * Planned delivery runs, at /api/routes.
 *
 * Operator+ throughout. A driver has no business here at all yet — the mobile app
 * knows nothing about routes, and a plan is a dispatcher's working document until
 * it is deliberately pushed to a phone.
 */
const router = Router();

router.use(authenticate, requireMinRole('operator'));

router.post('/', validate(createRouteSchema), controller.create);

/** What the DRIVERS tab loads when a driver is selected. */
router.get(
  '/driver/:driverId',
  validate(driverIdParamSchema, 'params'),
  controller.forDriver,
);

router.delete(
  '/driver/:driverId',
  validate(driverIdParamSchema, 'params'),
  controller.clear,
);

/** Apply an operator's own order. Strictly a permutation of the current stops. */
router.patch(
  '/:id/sequence',
  validate(routeIdParamSchema, 'params'),
  validate(reorderRouteSchema),
  controller.reorder,
);

/** What the optimiser WOULD do. Changes nothing — accepting it is a reorder. */
router.post('/:id/optimise', validate(routeIdParamSchema, 'params'), controller.optimise);

export default router;
