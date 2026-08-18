import { Router } from 'express';
import { requireMinRole } from '../../middleware/rbac.js';
import { allowOperatorOrAssignedDriver } from '../../middleware/ownership.js';
import { validate } from '../../middleware/validate.js';
import { uploadPodFiles } from '../../middleware/upload.js';
import { podBodySchema, podLegParamSchema } from '../../schemas/pod.schema.js';
import { consignmentIdParamSchema } from '../../schemas/consignment.schema.js';
import * as controller from './pod.controller.js';

// mergeParams so `:id` from the parent /api/consignments/:id/pod mount is visible.
const router = Router({ mergeParams: true });

router.get(
  '/',
  validate(consignmentIdParamSchema, 'params'),
  allowOperatorOrAssignedDriver,
  controller.list,
);

// Middleware order matters: params first (reject before reading an upload off the
// wire), then multer (req.body is undefined until it parses the multipart form),
// then the body schema.
// The whole point of the driver app: capture proof on your own job. Ownership is
// checked before multer reads the upload off the wire, so an unauthorised
// request costs nothing.
router.post(
  '/:leg',
  validate(podLegParamSchema, 'params'),
  allowOperatorOrAssignedDriver,
  uploadPodFiles,
  validate(podBodySchema),
  controller.capture,
);

router.put(
  '/:leg/files',
  requireMinRole('admin'),
  validate(podLegParamSchema, 'params'),
  uploadPodFiles,
  validate(podBodySchema),
  controller.replace,
);

export default router;
