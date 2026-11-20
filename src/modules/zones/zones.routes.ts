import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requireMinRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import {
  createZoneListSchema,
  createZoneSchema,
  listZonesQuerySchema,
  postalTextSchema,
  shapePreviewSchema,
  shapeSaveSchema,
  updateZoneListSchema,
  updateZoneSchema,
  zoneCodeParamSchema,
  zoneListIdParamSchema,
  zoneParamSchema,
} from '../../schemas/zone.schema.js';
import * as controller from './zones.controller.js';

const router = Router();

router.use(authenticate);

/*
 * Operators read zones, because every rate card and every quote is expressed in
 * them. Only admins redraw them: moving one postal code from one zone to another
 * silently reprices every future order that lands in it.
 */
router.get('/', requireMinRole('operator'), validate(listZonesQuerySchema, 'query'), controller.list);
router.get(
  '/:id',
  requireMinRole('operator'),
  validate(zoneListIdParamSchema, 'params'),
  validate(listZonesQuerySchema, 'query'),
  controller.get,
);

router.post('/', requireMinRole('admin'), validate(createZoneListSchema), controller.create);
router.patch(
  '/:id',
  requireMinRole('admin'),
  validate(zoneListIdParamSchema, 'params'),
  validate(updateZoneListSchema),
  controller.update,
);
router.delete('/:id', requireMinRole('admin'), validate(zoneListIdParamSchema, 'params'), controller.remove);

/* The zones inside one list. */
router.post(
  '/:id/zones',
  requireMinRole('admin'),
  validate(zoneListIdParamSchema, 'params'),
  validate(createZoneSchema),
  controller.createZone,
);
router.get(
  '/:id/zones/:zoneId',
  requireMinRole('operator'),
  validate(zoneParamSchema, 'params'),
  controller.getZone,
);
router.patch(
  '/:id/zones/:zoneId',
  requireMinRole('admin'),
  validate(zoneParamSchema, 'params'),
  validate(updateZoneSchema),
  controller.updateZone,
);
router.delete(
  '/:id/zones/:zoneId',
  requireMinRole('admin'),
  validate(zoneParamSchema, 'params'),
  controller.removeZone,
);

/*
 * The postal codes. `preview` writes nothing — it is a POST only because the
 * pasted box is a body, and it exists so an operator sees the invalid tokens and
 * the conflicts before anything is stored rather than after.
 */
router.post(
  '/:id/zones/:zoneId/codes/preview',
  requireMinRole('admin'),
  validate(zoneParamSchema, 'params'),
  validate(postalTextSchema),
  controller.previewCodes,
);
router.put(
  '/:id/zones/:zoneId/codes',
  requireMinRole('admin'),
  validate(zoneParamSchema, 'params'),
  validate(postalTextSchema),
  controller.saveCodes,
);
router.delete(
  '/:id/zones/:zoneId/codes/:code',
  requireMinRole('admin'),
  validate(zoneCodeParamSchema, 'params'),
  controller.removeCode,
);

/*
 * The drawn shape. `preview` answers "which postal codes does this cover?" and
 * writes nothing; the save takes the shape together with the codes the operator
 * kept, so unticking one in the preview actually leaves it out.
 *
 * Deleting the shape deliberately leaves its codes behind: the codes are what
 * pricing reads, and erasing a picture must never change a price.
 */
router.post(
  '/:id/zones/:zoneId/shape/preview',
  requireMinRole('admin'),
  validate(zoneParamSchema, 'params'),
  validate(shapePreviewSchema),
  controller.previewShape,
);
router.put(
  '/:id/zones/:zoneId/shape',
  requireMinRole('admin'),
  validate(zoneParamSchema, 'params'),
  validate(shapeSaveSchema),
  controller.saveShape,
);
router.delete(
  '/:id/zones/:zoneId/shape',
  requireMinRole('admin'),
  validate(zoneParamSchema, 'params'),
  controller.removeShape,
);

export default router;
