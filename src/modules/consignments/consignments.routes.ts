import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requireMinRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { allowOperatorOrAssignedDriver } from '../../middleware/ownership.js';
import { assignDriverSchema } from '../../schemas/assignment.schema.js';
import { bulkAssignSchema } from '../../schemas/bulkAssign.schema.js';
import {
  changeStatusSchema,
  consignmentIdParamSchema,
  createConsignmentSchema,
  updateConsignmentSchema,
} from '../../schemas/consignment.schema.js';
import podRoutes from '../pod/pod.routes.js';
import { listConsignmentsQuerySchema } from '../../schemas/query.schema.js';
import {
  driverRouteQuerySchema,
  nearestDriversQuerySchema,
} from '../../schemas/routing.schema.js';
import * as controller from './consignments.controller.js';
// Routing is its own module — it owns the OSRM client and will own route
// optimisation. The URL lives here because the question is about this order, the
// same way tracking sits under /api/drivers.
import * as routing from '../routing/routing.controller.js';

const router = Router();

router.use(authenticate);

// Feature 1 — client-scoped order logging.
// Driver assignment (Feature 2), proof of delivery (Feature 3) and manual status
// progression (Feature 4) mount here later.
router.post('/', requireMinRole('operator'), validate(createConsignmentSchema), controller.create);

// Reads are operator+ as well as writes. `authenticate` alone is not enough:
// a driver token is authenticated too, and drivers must not be able to read the
// whole book of work — especially while driver sign-in has no password.
router.get(
  '/',
  requireMinRole('operator'),
  validate(listConsignmentsQuerySchema, 'query'),
  controller.list,
);

// A driver may open a job they have been assigned — and only that one. The
// ownership guard is what makes this safe; role alone cannot express "yours".
router.get(
  '/:id',
  validate(consignmentIdParamSchema, 'params'),
  allowOperatorOrAssignedDriver,
  controller.getOne,
);

router.put(
  '/:id',
  requireMinRole('operator'),
  validate(consignmentIdParamSchema, 'params'),
  validate(updateConsignmentSchema),
  controller.update,
);

// Manual progression: the four "travelling / arrived" steps only. A request for
// PICKED_UP or DELIVERED is rejected by the schema — those need proof.
// The driver on the job moves it along; so may a dispatcher. The schema already
// restricts WHICH statuses are settable (never PICKED_UP or DELIVERED — those
// need proof), so ownership is the only extra question.
router.patch(
  '/:id/status',
  validate(consignmentIdParamSchema, 'params'),
  allowOperatorOrAssignedDriver,
  validate(changeStatusSchema),
  controller.changeStatus,
);

/*
 * Bulk assignment, for a rectangle drawn on the map.
 *
 * Registered BEFORE '/:id/assign' so the literal path is never swallowed by the
 * parameterised one — Express matches in declaration order, and 'assign-bulk'
 * would otherwise be read as an :id.
 */
router.post(
  '/assign-bulk',
  requireMinRole('operator'),
  validate(bulkAssignSchema),
  controller.assignBulk,
);

// Feature 2 — driver assignment.
router.post(
  '/:id/assign',
  requireMinRole('operator'),
  validate(consignmentIdParamSchema, 'params'),
  validate(assignDriverSchema),
  controller.assign,
);

router.delete(
  '/:id/assign',
  requireMinRole('operator'),
  validate(consignmentIdParamSchema, 'params'),
  controller.unassign,
);

/*
 * Who is closest to this pickup, ranked by driving time.
 *
 * Registered before the POD sub-router so a two-segment path is never a candidate
 * for it, and operator+ because it exposes the whole roster's live positions —
 * exactly what a driver token must not be able to read.
 */
router.get(
  '/:id/nearest-drivers',
  requireMinRole('operator'),
  validate(consignmentIdParamSchema, 'params'),
  validate(nearestDriversQuerySchema, 'query'),
  routing.nearestDrivers,
);

/*
 * The roads one driver would drive to reach this pickup — the line behind the
 * "8 min · 5.7 km" that /nearest-drivers already reports.
 *
 * Separate from that endpoint because OSRM's matrix service returns no geometry:
 * ranking the whole roster is one call, drawing a line is one call per driver. So
 * this is fetched for the driver an operator has actually selected.
 */
router.get(
  '/:id/driver-route',
  requireMinRole('operator'),
  validate(consignmentIdParamSchema, 'params'),
  validate(driverRouteQuerySchema, 'query'),
  routing.driverRoute,
);

// Feature 3 — proof of delivery, at /api/consignments/:id/pod/...
router.use('/:id/pod', podRoutes);

export default router;
