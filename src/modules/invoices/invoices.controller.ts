import { asyncHandler } from '../../utils/asyncHandler.js';
import { getValidatedQuery } from '../../middleware/validate.js';
import { AppError } from '../../utils/httpError.js';
import type { ListInvoicesQuery } from '../../schemas/invoice.schema.js';
import * as service from './invoices.service.js';
import * as pdf from './invoices.pdf.js';
import { sendInvoice } from './invoices.send.js';

/**
 * Who is doing this.
 *
 * `authenticate` guarantees it, but the type does not, and an invoice stamped
 * `createdBy: undefined` would be worse than a 401 — it would be a record with
 * nobody's name on it.
 */
function actor(req: { user?: { id: string } }): string {
  const id = req.user?.id;
  if (!id) throw AppError.unauthorized();
  return id;
}

export const list = asyncHandler(async (req, res) => {
  res.status(200).json(await service.listInvoices(getValidatedQuery<ListInvoicesQuery>(req)));
});

export const get = asyncHandler(async (req, res) => {
  res.status(200).json(await service.getInvoice(req.params.id as string));
});

export const preview = asyncHandler(async (req, res) => {
  res.status(200).json(await service.previewInvoice(req.body));
});

export const create = asyncHandler(async (req, res) => {
  res.status(201).json(await service.createInvoice(req.body, actor(req)));
});

export const update = asyncHandler(async (req, res) => {
  res.status(200).json(await service.updateInvoice(req.params.id as string, req.body));
});

export const remove = asyncHandler(async (req, res) => {
  await service.deleteInvoice(req.params.id as string);
  res.status(204).end();
});

export const approve = asyncHandler(async (req, res) => {
  res.status(200).json(await service.approveInvoice(req.params.id as string, actor(req)));
});

export const unapprove = asyncHandler(async (req, res) => {
  res.status(200).json(await service.unapproveInvoice(req.params.id as string));
});

/* ---------------------------------------------------------------- lines */

// Every line mutation returns the whole invoice: one edit moves the line's
// own totals, the levy, the tax and five figures in the header, so handing
// back anything smaller just makes the client reassemble it.
export const addLines = asyncHandler(async (req, res) => {
  res.status(200).json(await service.addLines(req.params.id as string, req.body));
});

export const removeLine = asyncHandler(async (req, res) => {
  res
    .status(200)
    .json(await service.removeLine(req.params.id as string, req.params.lineId as string));
});

export const editLine = asyncHandler(async (req, res) => {
  res
    .status(200)
    .json(await service.editLine(req.params.id as string, req.params.lineId as string, req.body));
});

export const repriceLine = asyncHandler(async (req, res) => {
  res
    .status(200)
    .json(await service.repriceLine(req.params.id as string, req.params.lineId as string));
});

/* ---------------------------------------------------------------- email */

export const send = asyncHandler(async (req, res) => {
  res.status(200).json(await sendInvoice(req.params.id as string, req.body, actor(req)));
});

/* ------------------------------------------------------------- settings */

export const getSettings = asyncHandler(async (_req, res) => {
  res.status(200).json(await service.getFinanceSettings());
});

export const putSettings = asyncHandler(async (req, res) => {
  res.status(200).json(await service.updateFinanceSettings(req.body));
});

/* ------------------------------------------------------------------ pdf */

export const print = asyncHandler(async (req, res) => {
  const doc = await pdf.invoicePdf(req.params.id as string);
  res
    .status(200)
    .set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${doc.filename}"`,
      'Content-Length': String(doc.body.length),
      // Rebuilt per request, so a reprint always shows the latest edit.
      'Cache-Control': 'no-store',
    })
    .send(doc.body);
});
