import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requireMinRole } from '../../middleware/rbac.js';
import * as controller from './reference.controller.js';

const router = Router();

router.use(authenticate);
// Console data (client list, driver roster with contact details) — not for a
// driver token.
router.get('/', requireMinRole('operator'), controller.get);

export default router;
