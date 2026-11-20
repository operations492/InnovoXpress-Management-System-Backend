import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requireMinRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import {
  cardServiceParamSchema,
  createRateCardSchema,
  listRateCardsQuerySchema,
  listRatesQuerySchema,
  putCardServiceSchema,
  putRouteRateSchema,
  quoteSchema,
  rateCardIdParamSchema,
  rateParamSchema,
  updateRateCardSchema,
} from '../../schemas/rateCard.schema.js';
import * as controller from './rateCards.controller.js';

const router = Router();

router.use(authenticate);

/*
 * Rates are margin. Operators may read them — a dispatcher quoting a job needs
 * to — but a driver must never see what their customer is charged, which is why
 * the floor here is `operator` and not the ownership check used on orders.
 */
router.get('/', requireMinRole('operator'), validate(listRateCardsQuerySchema, 'query'), controller.list);
router.get('/:id', requireMinRole('operator'), validate(rateCardIdParamSchema, 'params'), controller.get);

router.post('/', requireMinRole('admin'), validate(createRateCardSchema), controller.create);
router.patch(
  '/:id',
  requireMinRole('admin'),
  validate(rateCardIdParamSchema, 'params'),
  validate(updateRateCardSchema),
  controller.update,
);
router.delete('/:id', requireMinRole('admin'), validate(rateCardIdParamSchema, 'params'), controller.remove);

/*
 * What a job would cost on this card. A POST because the question has a body,
 * not because anything is created — it reads, stores nothing, and is open to
 * operators for the same reason the rates themselves are.
 */
router.post(
  '/:id/quote',
  requireMinRole('operator'),
  validate(rateCardIdParamSchema, 'params'),
  validate(quoteSchema),
  controller.quote,
);

/*
 * The grid. Reading is filtered by service level and freight item because that
 * is how the editor works: pick one of each, then fill in the zone pairs.
 */
router.get(
  '/:id/rates',
  requireMinRole('operator'),
  validate(rateCardIdParamSchema, 'params'),
  validate(listRatesQuerySchema, 'query'),
  controller.listRates,
);
router.put(
  '/:id/rates',
  requireMinRole('admin'),
  validate(rateCardIdParamSchema, 'params'),
  validate(putRouteRateSchema),
  controller.putRate,
);
router.delete(
  '/:id/rates/:rateId',
  requireMinRole('admin'),
  validate(rateParamSchema, 'params'),
  controller.removeRate,
);

/*
 * Accessorials. The catalogue holds what each charge is normally worth; this is
 * where one customer's price departs from it. Clearing every field removes the
 * override rather than storing a row of nulls, so the card goes back to
 * following the catalogue.
 */
router.get(
  '/:id/services',
  requireMinRole('operator'),
  validate(rateCardIdParamSchema, 'params'),
  controller.listServices,
);
router.put(
  '/:id/services',
  requireMinRole('admin'),
  validate(rateCardIdParamSchema, 'params'),
  validate(putCardServiceSchema),
  controller.putService,
);
router.delete(
  '/:id/services/:serviceId',
  requireMinRole('admin'),
  validate(cardServiceParamSchema, 'params'),
  controller.removeService,
);

export default router;
