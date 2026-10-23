import { asyncHandler } from '../../utils/asyncHandler.js';
import { getValidatedQuery } from '../../middleware/validate.js';
import type { ListRatePlansQuery } from '../../schemas/ratePlan.schema.js';
import * as service from './ratePlans.service.js';

export const list = asyncHandler(async (req, res) => {
  const q = getValidatedQuery<ListRatePlansQuery>(req);
  res.status(200).json(
    await service.listRatePlans({
      ...(q.clientId ? { clientId: q.clientId } : {}),
      includeInactive: q.includeInactive === 'true',
    }),
  );
});

export const get = asyncHandler(async (req, res) => {
  res.status(200).json(await service.getRatePlan(req.params.id as string));
});

export const create = asyncHandler(async (req, res) => {
  res.status(201).json(await service.createRatePlan(req.body));
});

export const update = asyncHandler(async (req, res) => {
  res.status(200).json(await service.updateRatePlan(req.params.id as string, req.body));
});

export const setItems = asyncHandler(async (req, res) => {
  res.status(200).json(await service.setRatePlanItems(req.params.id as string, req.body));
});

export const remove = asyncHandler(async (req, res) => {
  await service.deleteRatePlan(req.params.id as string);
  res.status(204).end();
});
