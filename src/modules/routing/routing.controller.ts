import { asyncHandler } from '../../utils/asyncHandler.js';
import { getValidatedQuery } from '../../middleware/validate.js';
import type { DriverRouteQuery, NearestDriversQuery } from '../../schemas/routing.schema.js';
import * as service from './routing.service.js';

export const nearestDrivers = asyncHandler(async (req, res) => {
  const { id } = req.params as unknown as { id: string };
  const query = getValidatedQuery<NearestDriversQuery>(req);
  res.status(200).json(await service.nearestDrivers(id, query));
});

export const driverRoute = asyncHandler(async (req, res) => {
  const { id } = req.params as unknown as { id: string };
  const query = getValidatedQuery<DriverRouteQuery>(req);
  res.status(200).json(await service.driverRoute(id, query));
});
