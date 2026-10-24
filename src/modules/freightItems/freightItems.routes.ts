import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requireMinRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import {
  catalogIdParamSchema,
  createCatalogEntrySchema,
  listCatalogQuerySchema,
  updateCatalogEntrySchema,
} from '../../schemas/catalog.schema.js';
import * as controller from './freightItems.controller.js';

const router = Router();

router.use(authenticate);

// Operators read the list; only admins change it, since a rate plan prices
// every entry and a rename reaches every plan that referenced it.
router.get('/', requireMinRole('operator'), validate(listCatalogQuerySchema, 'query'), controller.list);
router.get('/:id', requireMinRole('operator'), validate(catalogIdParamSchema, 'params'), controller.get);

router.post('/', requireMinRole('admin'), validate(createCatalogEntrySchema), controller.create);
router.patch(
  '/:id',
  requireMinRole('admin'),
  validate(catalogIdParamSchema, 'params'),
  validate(updateCatalogEntrySchema),
  controller.update,
);
router.delete('/:id', requireMinRole('admin'), validate(catalogIdParamSchema, 'params'), controller.remove);

export default router;
