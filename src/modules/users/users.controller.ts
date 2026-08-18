import type { Request, Response } from 'express';
import * as service from './users.service.js';
import { AppError } from '../../utils/httpError.js';
import { getValidatedQuery } from '../../middleware/validate.js';
import type { UsersQuery } from '../../schemas/user.schema.js';

/** Express 5 types params loosely; every route here declares `:id`. */
const idOf = (req: Request) => (req.params as unknown as { id: string }).id;

const actorOf = (req: Request) => {
  if (!req.user) throw AppError.unauthorized();
  return req.user.id;
};

export async function list(req: Request, res: Response) {
  res.status(200).json(await service.list(getValidatedQuery<UsersQuery>(req)));
}

export async function unlinkedDrivers(_req: Request, res: Response) {
  res.status(200).json(await service.unlinkedDrivers());
}

export async function get(req: Request, res: Response) {
  res.status(200).json({ user: await service.get(idOf(req)) });
}

export async function create(req: Request, res: Response) {
  res.status(201).json({ user: await service.create(req.body) });
}

export async function update(req: Request, res: Response) {
  res.status(200).json({ user: await service.update(idOf(req), req.body, actorOf(req)) });
}

export async function remove(req: Request, res: Response) {
  res.status(200).json(await service.remove(idOf(req), actorOf(req)));
}

export async function removeDriver(req: Request, res: Response) {
  res.status(200).json(await service.removeDriver(idOf(req)));
}
