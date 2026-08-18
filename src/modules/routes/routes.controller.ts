import type { Request } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { AppError } from '../../utils/httpError.js';
import type { CreateRouteInput, ReorderRouteInput } from '../../schemas/route.schema.js';
import * as service from './routes.service.js';

function actorId(req: Request): string {
  if (!req.user) throw AppError.unauthorized();
  return req.user.id;
}

const routeIdOf = (req: Request) => (req.params as unknown as { id: string }).id;
const driverIdOf = (req: Request) => (req.params as unknown as { driverId: string }).driverId;

export const create = asyncHandler(async (req, res) => {
  const created = await service.createRoute(req.body as CreateRouteInput, actorId(req));
  res.status(201).json(created);
});

export const forDriver = asyncHandler(async (req, res) => {
  // 200 with `null` rather than 404: "this driver has no plan" is a normal answer
  // the DRIVERS tab asks for constantly, not an error worth a red toast.
  res.status(200).json({ route: await service.activeRoute(driverIdOf(req)) });
});

export const reorder = asyncHandler(async (req, res) => {
  res.status(200).json(await service.reorder(routeIdOf(req), req.body as ReorderRouteInput));
});

export const optimise = asyncHandler(async (req, res) => {
  res.status(200).json(await service.optimisePreview(routeIdOf(req)));
});

export const clear = asyncHandler(async (req, res) => {
  res.status(200).json(await service.clearRoute(driverIdOf(req)));
});
