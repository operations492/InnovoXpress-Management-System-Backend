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
import { uploadDocSignature, uploadOrderDoc } from '../../middleware/upload.js';
import {
  docFlagsSchema,
  docKindParamSchema,
  docListQuerySchema,
  docSignParamSchema,
} from '../../schemas/orderDoc.schema.js';
import * as controller from './consignments.controller.js';
// Routing is its own module — it owns the OSRM client and will own route
// optimisation. The URL lives here because the question is about this order, the
// same way tracking sits under /api/drivers.
import * as routing from '../routing/routing.controller.js';
// Printable paperwork is its own module too; the URLs sit here because the
// document is about this order.
import * as documents from '../documents/documents.controller.js';
// Uploaded paperwork — the release letter and the bill of lading — is a third
// module again. `documents` above GENERATES pdfs; this one STORES them.
import * as orderDocs from '../orderDocs/orderDocs.controller.js';

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

/*
 * Printable paperwork: a set of 4x6 labels, and the two-up A4 docket.
 *
 * Two documents rather than one, because they go to two different printers - a
 * thermal roll and office paper - so a combined PDF would be split by hand every
 * single time. The `.pdf` suffix is in the path so a browser tab, a download and
 * a print dialog all name the file sensibly; the param schema still sees only :id.
 */
router.get(
  '/:id/label.pdf',
  requireMinRole('operator'),
  validate(consignmentIdParamSchema, 'params'),
  documents.label,
);

router.get(
  '/:id/docket.pdf',
  requireMinRole('operator'),
  validate(consignmentIdParamSchema, 'params'),
  documents.docket,
);

/*
 * The POD report: the signed, timestamped, located proof of the whole job.
 *
 * Declared before the POD sub-router mounted at '/:id/pod' — `router.use`
 * matches on prefix, so '/:id/pod-report.pdf' would otherwise be a candidate for
 * it. Same convention as /nearest-drivers and /release-letter above.
 *
 * The service returns 409 until the order is delivered; this is only the gate on
 * who may ask.
 */
router.get(
  '/:id/pod-report.pdf',
  requireMinRole('operator'),
  validate(consignmentIdParamSchema, 'params'),
  documents.podReport,
);

/*
 * Uploaded paperwork: the release letter a driver shows at a cargo desk, and the
 * bill of lading. Either may be configured to appear at the collection, at the
 * drop, or both — and to require a signature at either.
 *
 * Declared before the POD sub-router so a two-segment path is never a candidate
 * for it, the same convention as /nearest-drivers above.
 *
 * READING is a driver route, and only for a job that is theirs: a driver standing
 * at a stop seeing exactly the paperwork that applies there is the entire point.
 * `?leg=` narrows it to that stop. Configuring and clearing are operator+, the
 * same bar as editing the order the documents belong to.
 */
router.get(
  '/:id/documents',
  validate(consignmentIdParamSchema, 'params'),
  allowOperatorOrAssignedDriver,
  validate(docListQuerySchema, 'query'),
  orderDocs.list,
);

router.post(
  '/:id/documents/:kind',
  requireMinRole('operator'),
  validate(docKindParamSchema, 'params'),
  uploadOrderDoc,
  orderDocs.put,
);

// Flags only, as JSON. They cannot ride along with the upload: `uploadOrderDoc`
// is configured with `fields: 0`, so a multipart text field is a hard reject.
router.patch(
  '/:id/documents/:kind',
  requireMinRole('operator'),
  validate(docKindParamSchema, 'params'),
  validate(docFlagsSchema),
  orderDocs.setFlags,
);

router.delete(
  '/:id/documents/:kind',
  requireMinRole('operator'),
  validate(docKindParamSchema, 'params'),
  orderDocs.remove,
);

/*
 * The signature itself, captured on the phone at the stop. A driver signs their
 * own job; an operator may also sign, for paperwork faxed back to the office.
 *
 * This is what makes the sign flags real: until this has been called for every
 * document marked for this leg, POD capture is refused.
 */
router.post(
  '/:id/documents/:kind/sign/:leg',
  validate(docSignParamSchema, 'params'),
  allowOperatorOrAssignedDriver,
  uploadDocSignature,
  orderDocs.sign,
);

/*
 * DEPRECATED — the old single-document release letter endpoints, served from the
 * new table so the driver build already in drivers' hands and the console keep
 * working. Breaking a deployed phone app is not a refactor, it is an outage.
 * Remove once both clients have moved to /documents.
 */
router.get(
  '/:id/release-letter',
  validate(consignmentIdParamSchema, 'params'),
  allowOperatorOrAssignedDriver,
  orderDocs.releaseLetter,
);

router.post(
  '/:id/release-letter',
  requireMinRole('operator'),
  validate(consignmentIdParamSchema, 'params'),
  uploadOrderDoc,
  orderDocs.putReleaseLetter,
);

router.delete(
  '/:id/release-letter',
  requireMinRole('operator'),
  validate(consignmentIdParamSchema, 'params'),
  orderDocs.removeReleaseLetter,
);

// Feature 3 — proof of delivery, at /api/consignments/:id/pod/...
router.use('/:id/pod', podRoutes);

export default router;
