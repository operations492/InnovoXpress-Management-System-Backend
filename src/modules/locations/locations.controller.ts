import type { Request } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { getValidatedQuery } from '../../middleware/validate.js';
import { AppError } from '../../utils/httpError.js';
import type { LatestLocationsQuery, TrailQuery } from '../../schemas/driver.schema.js';
import * as service from './locations.service.js';

function driverIdOf(req: Request): string {
  const id = req.user?.driverId;
  if (!id) throw AppError.forbidden('This endpoint is for the driver app');
  return id;
}

export const record = asyncHandler(async (req, res) => {
  // The driver id comes from the token, never from the body — a driver may only
  // report their own position.
  res.status(201).json(await service.recordLocations(driverIdOf(req), req.body));
});

export const latest = asyncHandler(async (req, res) => {
  const query = getValidatedQuery<LatestLocationsQuery>(req);
  res.status(200).json(await service.latestLocations(query));
});

export const trail = asyncHandler(async (req, res) => {
  const id = (req.params as unknown as { id: string }).id;
  const query = getValidatedQuery<TrailQuery>(req);
  res.status(200).json(await service.driverTrail(id, query));
});
