import type { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import * as service from './documents.service.js';

/**
 * Express 5 types every path param as `string | string[]`. The route validates
 * `:id` with consignmentIdParamSchema first, so by the time a handler runs it is
 * a single validated string.
 */
function idOf(req: Request): string {
  return (req.params as unknown as { id: string }).id;
}

/**
 * `inline` rather than `attachment`: the console opens these in a tab so the
 * operator gets the browser's own print dialog. `no-store` because a document
 * reprinted after an edit must never come back from a cache.
 */
function sendPdf(res: Response, pdf: service.RenderedPdf) {
  res
    .status(200)
    .set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${pdf.filename}"`,
      'Content-Length': String(pdf.body.length),
      'Cache-Control': 'no-store',
    })
    .send(pdf.body);
}

export const label = asyncHandler(async (req, res) => {
  sendPdf(res, await service.labelPdf(idOf(req)));
});

export const docket = asyncHandler(async (req, res) => {
  sendPdf(res, await service.docketPdf(idOf(req)));
});

export const podReport = asyncHandler(async (req, res) => {
  sendPdf(res, await service.podReportPdf(idOf(req)));
});
