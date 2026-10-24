import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requireMinRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import {
  clientIdParamSchema,
  createClientSchema,
  listClientsQuerySchema,
  updateClientSchema,
} from '../../schemas/client.schema.js';
import * as controller from './clients.controller.js';

const router = Router();

router.use(authenticate);

// Operators read the list — the consignment form's client dropdown prefills the
// sender from it — but only admins change it, since the code is stamped into
// every order number the client is ever given.
router.get('/', requireMinRole('operator'), validate(listClientsQuerySchema, 'query'), controller.list);
router.get('/:id', requireMinRole('operator'), validate(clientIdParamSchema, 'params'), controller.get);

router.post('/', requireMinRole('admin'), validate(createClientSchema), controller.create);
router.patch(
  '/:id',
  requireMinRole('admin'),
  validate(clientIdParamSchema, 'params'),
  validate(updateClientSchema),
  controller.update,
);
router.delete('/:id', requireMinRole('admin'), validate(clientIdParamSchema, 'params'), controller.remove);

export default router;
