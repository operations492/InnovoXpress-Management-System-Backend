import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requireDriver, requireMinRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { driversQuerySchema } from '../../schemas/assignment.schema.js';
import {
  createDriverSchema,
  driverDocKindParamSchema,
  driverIdParamSchema,
  latestLocationsQuerySchema,
  myConsignmentsQuerySchema,
  recordLocationsSchema,
  trailQuerySchema,
  updateDriverSchema,
} from '../../schemas/driver.schema.js';
import { shiftSchema } from '../../schemas/user.schema.js';
import { consignmentIdParamSchema } from '../../schemas/consignment.schema.js';
import * as controller from './drivers.controller.js';
// Tracking is its own module; the routes live here because the URLs sit under
// /api/drivers and moving them would break callers for no gain.
import * as locations from '../locations/locations.controller.js';
import { uploadDriverDoc } from '../../middleware/upload.js';

const router = Router();

/**
 * There are no unauthenticated routes here any more.
 *
 * `GET /roster` and `POST /session` used to let the driver app list every
 * courier and sign in as any of them with no password — anyone holding the URL
 * could close another driver's jobs. Drivers now hold real Supabase accounts,
 * so both are gone along with ALLOW_DRIVER_SELF_SELECT.
 */
router.use(authenticate);

// Driver app: my own work list and my own position. Both scoped by the token,
// so there is no id in the URL for a driver to tamper with.
router.get(
  '/me/consignments',
  requireDriver,
  validate(myConsignmentsQuerySchema, 'query'),
  controller.myConsignments,
);

router.post(
  '/me/locations',
  requireDriver,
  validate(recordLocationsSchema),
  locations.record,
);

// Clocking on and off. Only on-shift drivers are offered to an operator when
// assigning, so this is the switch that makes a driver assignable.
router.post('/me/shift', requireDriver, validate(shiftSchema), controller.setShift);

// Console: the roster, the live map, and one driver's trail.
router.get(
  '/',
  requireMinRole('operator'),
  validate(driversQuerySchema, 'query'),
  controller.list,
);

router.get(
  '/locations/latest',
  requireMinRole('operator'),
  validate(latestLocationsQuerySchema, 'query'),
  locations.latest,
);

router.get(
  '/:id/trail',
  requireMinRole('operator'),
  validate(consignmentIdParamSchema, 'params'),
  validate(trailQuerySchema, 'query'),
  locations.trail,
);

// The Drivers tab owns the roster. Reads are operator+, writes are admin.
router.get('/:id', requireMinRole('operator'), validate(driverIdParamSchema, 'params'), controller.get);

router.post('/', requireMinRole('admin'), validate(createDriverSchema), controller.create);

router.patch(
  '/:id',
  requireMinRole('admin'),
  validate(driverIdParamSchema, 'params'),
  validate(updateDriverSchema),
  controller.update,
);

// Moved from /api/users/drivers/:id, which still works and calls the same code.
router.delete(
  '/:id',
  requireMinRole('admin'),
  validate(driverIdParamSchema, 'params'),
  controller.remove,
);

// Photo + ID card. Both links in one read; uploads are admin-only.
router.get(
  '/:id/documents',
  requireMinRole('operator'),
  validate(driverIdParamSchema, 'params'),
  controller.documents,
);

router.post(
  '/:id/documents/:kind',
  requireMinRole('admin'),
  validate(driverDocKindParamSchema, 'params'),
  uploadDriverDoc,
  controller.putDocument,
);

export default router;
