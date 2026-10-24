import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requireMinRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { previewInvoiceSchema } from '../../schemas/invoice.schema.js';
import * as controller from './invoices.controller.js';

const router = Router();

router.use(authenticate);

// Operator+, never below: a price is margin and the driver app shares this API.
// POST rather than GET because the selection is a body, not a query string; it
// still writes nothing.
router.post('/preview', requireMinRole('operator'), validate(previewInvoiceSchema), controller.preview);

export default router;
