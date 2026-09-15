import { asyncHandler } from '../../utils/asyncHandler.js';
import { getValidatedQuery } from '../../middleware/validate.js';
import type { ListServiceLevelsQuery } from '../../schemas/serviceLevel.schema.js';
import * as service from './serviceLevels.service.js';

export const list = asyncHandler(async (req, res) => {
  const q = getValidatedQuery<ListServiceLevelsQuery>(req);
  res.status(200).json(await service.listServiceLevels(q.includeInactive === 'true'));
});

export const get = asyncHandler(async (req, res) => {
  res.status(200).json(await service.getServiceLevel(req.params.id as string));
});

export const create = asyncHandler(async (req, res) => {
  res.status(201).json(await service.createServiceLevel(req.body));
});

export const update = asyncHandler(async (req, res) => {
  res.status(200).json(await service.updateServiceLevel(req.params.id as string, req.body));
});

export const remove = asyncHandler(async (req, res) => {
  await service.deleteServiceLevel(req.params.id as string);
  res.status(204).end();
});
