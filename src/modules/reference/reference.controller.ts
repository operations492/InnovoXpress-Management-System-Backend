import { asyncHandler } from '../../utils/asyncHandler.js';
import { getReference } from './reference.service.js';

export const get = asyncHandler(async (_req, res) => {
  res.status(200).json(await getReference());
});
