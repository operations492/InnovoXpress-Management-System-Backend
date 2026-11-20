import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requireMinRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import {
  addLinesSchema,
  createInvoiceSchema,
  editLineSchema,
  invoiceIdParamSchema,
  invoiceLineParamSchema,
  listInvoicesQuerySchema,
  previewInvoiceSchema,
  sendInvoiceSchema,
  updateFinanceSettingsSchema,
  updateInvoiceSchema,
} from '../../schemas/invoice.schema.js';
import * as controller from './invoices.controller.js';

const router = Router();

router.use(authenticate);

/*
 * An invoice is margin made explicit, so the floor is `operator` throughout —
 * the same reasoning as the rate cards it is built from, and a driver must
 * never see what their customer was charged.
 *
 * Approval is the one exception and is admin-only. It is the act that freezes
 * the numbers and puts a name against them, which is a different kind of
 * authority from raising the paperwork.
 */

/* ------------------------------------------------------------- settings */
// Before /:id, or "settings" is read as an invoice id.
router.get('/settings', requireMinRole('operator'), controller.getSettings);
router.put(
  '/settings',
  requireMinRole('admin'),
  validate(updateFinanceSettingsSchema),
  controller.putSettings,
);

/* --------------------------------------------------------------- browse */
router.get('/', requireMinRole('operator'), validate(listInvoicesQuerySchema, 'query'), controller.list);

/*
 * What could be billed. A POST because the question carries a body and prices
 * every candidate on the way through; nothing is created or stored.
 */
router.post('/preview', requireMinRole('operator'), validate(previewInvoiceSchema), controller.preview);

router.post('/', requireMinRole('operator'), validate(createInvoiceSchema), controller.create);

router.get('/:id', requireMinRole('operator'), validate(invoiceIdParamSchema, 'params'), controller.get);

router.get(
  '/:id/invoice.pdf',
  requireMinRole('operator'),
  validate(invoiceIdParamSchema, 'params'),
  controller.print,
);

router.patch(
  '/:id',
  requireMinRole('operator'),
  validate(invoiceIdParamSchema, 'params'),
  validate(updateInvoiceSchema),
  controller.update,
);

router.delete(
  '/:id',
  requireMinRole('admin'),
  validate(invoiceIdParamSchema, 'params'),
  controller.remove,
);

/* ------------------------------------------------------------- approval */
router.post(
  '/:id/approve',
  requireMinRole('admin'),
  validate(invoiceIdParamSchema, 'params'),
  controller.approve,
);
router.post(
  '/:id/unapprove',
  requireMinRole('admin'),
  validate(invoiceIdParamSchema, 'params'),
  controller.unapprove,
);

/* ---------------------------------------------------------------- email */
// Operator+, not admin: approval is the act that needs authority, and the
// service refuses anything not yet approved. Sending what is already final is
// clerical.
router.post(
  '/:id/send',
  requireMinRole('operator'),
  validate(invoiceIdParamSchema, 'params'),
  validate(sendInvoiceSchema),
  controller.send,
);

/* ---------------------------------------------------------------- lines */
router.post(
  '/:id/lines',
  requireMinRole('operator'),
  validate(invoiceIdParamSchema, 'params'),
  validate(addLinesSchema),
  controller.addLines,
);
router.delete(
  '/:id/lines/:lineId',
  requireMinRole('operator'),
  validate(invoiceLineParamSchema, 'params'),
  controller.removeLine,
);
router.patch(
  '/:id/lines/:lineId',
  requireMinRole('operator'),
  validate(invoiceLineParamSchema, 'params'),
  validate(editLineSchema),
  controller.editLine,
);
router.post(
  '/:id/lines/:lineId/reprice',
  requireMinRole('operator'),
  validate(invoiceLineParamSchema, 'params'),
  controller.repriceLine,
);

export default router;
