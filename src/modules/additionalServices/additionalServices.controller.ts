import { asyncHandler } from '../../utils/asyncHandler.js';
import { getValidatedQuery } from '../../middleware/validate.js';
import type { ListCatalogQuery } from '../../schemas/catalog.schema.js';
import * as service from './additionalServices.service.js';

export const list = asyncHandler(async (req, res) => {
  const q = getValidatedQuery<ListCatalogQuery>(req);
  res.status(200).json(await service.listAdditionalServices(q.includeInactive === 'true'));
});

export const get = asyncHandler(async (req, res) => {
  res.status(200).json(await service.getAdditionalService(req.params.id as string));
});

export const create = asyncHandler(async (req, res) => {
  res.status(201).json(await service.createAdditionalService(req.body));
});

export const update = asyncHandler(async (req, res) => {
  res.status(200).json(await service.updateAdditionalService(req.params.id as string, req.body));
});

export const remove = asyncHandler(async (req, res) => {
  await service.deleteAdditionalService(req.params.id as string);
  res.status(204).end();
});
