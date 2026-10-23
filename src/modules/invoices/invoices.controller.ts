import { asyncHandler } from '../../utils/asyncHandler.js';
import * as service from './invoices.service.js';

export const preview = asyncHandler(async (req, res) => {
  res.status(200).json(await service.previewInvoice(req.body));
});
