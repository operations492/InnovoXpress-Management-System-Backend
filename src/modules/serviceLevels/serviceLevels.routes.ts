import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requireMinRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import {
  createServiceLevelSchema,
  listServiceLevelsQuerySchema,
  serviceLevelIdParamSchema,
  updateServiceLevelSchema,
} from '../../schemas/serviceLevel.schema.js';
import * as controller from './serviceLevels.controller.js';

const router = Router();

router.use(authenticate);

// Operators read the list (the consignment form's dropdown also gets it via
// /api/reference); only admins change it, since a rename touches every order.
router.get('/', requireMinRole('operator'), validate(listServiceLevelsQuerySchema, 'query'), controller.list);
router.get('/:id', requireMinRole('operator'), validate(serviceLevelIdParamSchema, 'params'), controller.get);

router.post('/', requireMinRole('admin'), validate(createServiceLevelSchema), controller.create);
router.patch(
  '/:id',
  requireMinRole('admin'),
  validate(serviceLevelIdParamSchema, 'params'),
  validate(updateServiceLevelSchema),
  controller.update,
);
router.delete('/:id', requireMinRole('admin'), validate(serviceLevelIdParamSchema, 'params'), controller.remove);

export default router;
