import { asyncHandler } from '../../utils/asyncHandler.js';
import { getValidatedQuery } from '../../middleware/validate.js';
import type { ListClientsQuery } from '../../schemas/client.schema.js';
import * as service from './clients.service.js';

export const list = asyncHandler(async (req, res) => {
  const q = getValidatedQuery<ListClientsQuery>(req);
  res.status(200).json(await service.listClients(q.includeInactive === 'true'));
});

export const get = asyncHandler(async (req, res) => {
  res.status(200).json(await service.getClient(req.params.id as string));
});

export const create = asyncHandler(async (req, res) => {
  res.status(201).json(await service.createClient(req.body));
});

export const update = asyncHandler(async (req, res) => {
  res.status(200).json(await service.updateClient(req.params.id as string, req.body));
});

export const remove = asyncHandler(async (req, res) => {
  await service.deleteClient(req.params.id as string);
  res.status(204).end();
});
