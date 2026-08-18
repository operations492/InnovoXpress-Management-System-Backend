import type { Request } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { getValidatedQuery } from '../../middleware/validate.js';
import { AppError } from '../../utils/httpError.js';
import type { ListConsignmentsQuery } from '../../schemas/query.schema.js';
import * as service from './consignments.service.js';

function actorOf(req: Request): service.Actor {
  if (!req.user) throw AppError.unauthorized();
  return { id: req.user.id, email: req.user.email };
}

/**
 * Express 5 types every path param as `string | string[]`. The route validates
 * `:id` with consignmentIdParamSchema first, so by the time a handler runs it is
 * a single validated string.
 */
function idOf(req: Request): string {
  return (req.params as unknown as { id: string }).id;
}

export const create = asyncHandler(async (req, res) => {
  const created = await service.createConsignment(req.body, actorOf(req));
  res.status(201).json(created);
});

export const list = asyncHandler(async (req, res) => {
  const query = getValidatedQuery<ListConsignmentsQuery>(req);
  res.status(200).json(await service.listConsignments(query));
});

export const getOne = asyncHandler(async (req, res) => {
  res.status(200).json(await service.getConsignment(idOf(req)));
});

export const update = asyncHandler(async (req, res) => {
  const updated = await service.updateConsignment(idOf(req), req.body, actorOf(req));
  res.status(200).json(updated);
});

export const changeStatus = asyncHandler(async (req, res) => {
  const updated = await service.changeStatus(idOf(req), req.body, actorOf(req));
  res.status(200).json(updated);
});

export const assignBulk = asyncHandler(async (req, res) => {
  // 200, never 207. Partial success is the normal outcome here, and a status code
  // most HTTP clients treat as exotic would push every caller into special-casing
  // what is really just a body to read.
  res.status(200).json(await service.assignDriverBulk(req.body, actorOf(req)));
});

export const assign = asyncHandler(async (req, res) => {
  const updated = await service.assignDriver(idOf(req), req.body, actorOf(req));
  res.status(200).json(updated);
});

export const unassign = asyncHandler(async (req, res) => {
  const updated = await service.unassignDriver(idOf(req), actorOf(req));
  res.status(200).json(updated);
});
