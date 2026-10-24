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
  const q = getValidatedQuery<{
    includeDelivered: string;
    scope?: 'live' | 'delivered';
    page?: number;
    pageSize?: number;
  }>(req);
  res
    .status(200)
    .json(
      await workService.myConsignments(driverIdOf(req), {
        scope: q.scope,
        includeDelivered: q.includeDelivered === 'true',
        page: q.page,
        pageSize: q.pageSize,
      }),
    );
});

/* ------------------------------------------------- roster CRUD + documents */

export const get = asyncHandler(async (req, res) => {
  res.status(200).json(await driversService.getDriver(req.params.id as string));
});

export const create = asyncHandler(async (req, res) => {
  res.status(201).json(await driversService.createDriver(req.body));
});

export const update = asyncHandler(async (req, res) => {
  res.status(200).json(await driversService.updateDriver(req.params.id as string, req.body));
});

/**
 * Removing a courier still runs the users-module rule: it is a 409 once they have
 * any consignment or proof, because deleting would erase who delivered what. The
 * logic was not copied — the old `/api/users/drivers/:id` route calls the same
 * function, so there is one implementation of that refusal.
 */
export const remove = asyncHandler(async (req, res) => {
  res.status(200).json(await usersService.removeDriver(req.params.id as string));
});

export const documents = asyncHandler(async (req, res) => {
  res.status(200).json(await driversService.driverDocuments(req.params.id as string));
});

export const putDocument = asyncHandler(async (req, res) => {
  const kind = req.params.kind as 'photo' | 'id-card';
  res
    .status(200)
    .json(await driversService.putDriverDocument(req.params.id as string, kind, req.file));
});
