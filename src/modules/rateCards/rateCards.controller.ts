import { asyncHandler } from '../../utils/asyncHandler.js';
import { getValidatedQuery } from '../../middleware/validate.js';
import type { ListRateCardsQuery, ListRatesQuery } from '../../schemas/rateCard.schema.js';
import * as service from './rateCards.service.js';

export const list = asyncHandler(async (req, res) => {
  const q = getValidatedQuery<ListRateCardsQuery>(req);
  res.status(200).json(await service.listRateCards(q.clientId, q.includeInactive === 'true'));
});

export const get = asyncHandler(async (req, res) => {
  res.status(200).json(await service.getRateCard(req.params.id as string));
});

export const create = asyncHandler(async (req, res) => {
  res.status(201).json(await service.createRateCard(req.body));
});

export const update = asyncHandler(async (req, res) => {
  res.status(200).json(await service.updateRateCard(req.params.id as string, req.body));
});

export const remove = asyncHandler(async (req, res) => {
  await service.deleteRateCard(req.params.id as string);
  res.status(204).end();
});

export const quote = asyncHandler(async (req, res) => {
  res.status(200).json(await service.quoteRateCard(req.params.id as string, req.body));
});

/* ------------------------------------------------------------------ rates */

export const listRates = asyncHandler(async (req, res) => {
  const q = getValidatedQuery<ListRatesQuery>(req);
  res.status(200).json(await service.listRouteRates(req.params.id as string, q));
});

export const putRate = asyncHandler(async (req, res) => {
  res.status(200).json(await service.putRouteRate(req.params.id as string, req.body));
});

export const removeRate = asyncHandler(async (req, res) => {
  await service.deleteRouteRate(req.params.id as string, req.params.rateId as string);
  res.status(204).end();
});

/* ----------------------------------------------- additional services */

export const listServices = asyncHandler(async (req, res) => {
  res.status(200).json(await service.listCardServices(req.params.id as string));
});

// Writes return the whole list: one dialog shows every service at once, so a
// single changed row would only have to be merged back in by the client.
export const putService = asyncHandler(async (req, res) => {
  res.status(200).json(await service.putCardService(req.params.id as string, req.body));
});

export const removeService = asyncHandler(async (req, res) => {
  res
    .status(200)
    .json(await service.removeCardService(req.params.id as string, req.params.serviceId as string));
});
