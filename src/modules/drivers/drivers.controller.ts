import type { Request } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { getValidatedQuery } from '../../middleware/validate.js';
import { AppError } from '../../utils/httpError.js';
import type { DriversQuery } from '../../schemas/assignment.schema.js';
import * as driversService from './drivers.service.js';
import * as workService from './driverWork.service.js';
import * as usersService from '../users/users.service.js';

function driverIdOf(req: Request): string {
  const id = req.user?.driverId;
  if (!id) throw AppError.forbidden('This endpoint is for the driver app');
  return id;
}

/* ------------------------------------------------------------------- console */

export const list = asyncHandler(async (req, res) => {
  const query = getValidatedQuery<DriversQuery>(req);
  res.status(200).json(await driversService.listDrivers(query));
});

/* ------------------------------------------------------------------- the shift */

/**
 * The driver's own clock-in switch. Only an on-shift driver appears in the
 * operator's assignment list, so this is what makes them assignable.
 */
export const setShift = asyncHandler(async (req, res) => {
  res.status(200).json(await usersService.setShift(driverIdOf(req), req.body.onShift));
});

/* ------------------------------------------------------------ driver work list */

export const myConsignments = asyncHandler(async (req, res) => {
  const q = getValidatedQuery<{ includeDelivered: string }>(req);
  res
    .status(200)
    .json(await workService.myConsignments(driverIdOf(req), q.includeDelivered === 'true'));
});
