import type { Request, Response } from 'express';
import * as service from './map.service.js';
import { getValidatedQuery } from '../../middleware/validate.js';
import type { MapDriversQuery, MapPinsQuery } from '../../schemas/map.schema.js';

/* HTTP in, plain arguments out. No business rules here. */

export async function pins(req: Request, res: Response) {
  const query = getValidatedQuery<MapPinsQuery>(req);
  res.status(200).json(await service.pins(query));
}

export async function drivers(req: Request, res: Response) {
  const query = getValidatedQuery<MapDriversQuery>(req);
  res.status(200).json(await service.drivers(query));
}
