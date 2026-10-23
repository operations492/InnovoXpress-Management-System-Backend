import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requireMinRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import {
  createRatePlanSchema,
  listRatePlansQuerySchema,
  ratePlanIdParamSchema,
  setRatePlanItemsSchema,
  updateRatePlanSchema,
} from '../../schemas/ratePlan.schema.js';
import * as controller from './ratePlans.controller.js';

const router = Router();

router.use(authenticate);

// Operator+ throughout, and never below: rates are margin. A driver must not be
// able to read what their client is charged.
router.get('/', requireMinRole('operator'), validate(listRatePlansQuerySchema, 'query'), controller.list);
router.get('/:id', requireMinRole('operator'), validate(ratePlanIdParamSchema, 'params'), controller.get);

router.post('/', requireMinRole('admin'), validate(createRatePlanSchema), controller.create);
router.patch(
  '/:id',
  requireMinRole('admin'),
  validate(ratePlanIdParamSchema, 'params'),
  validate(updateRatePlanSchema),
  controller.update,
);
// The whole price grid in one call — the editor's Save button.
router.put(
  '/:id/items',
  requireMinRole('admin'),
  validate(ratePlanIdParamSchema, 'params'),
  validate(setRatePlanItemsSchema),
  controller.setItems,
);
router.delete('/:id', requireMinRole('admin'), validate(ratePlanIdParamSchema, 'params'), controller.remove);

export default router;
