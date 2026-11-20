import { z } from 'zod';

/**
 * Money arrives as a number and is stored as Decimal(12,2). Two decimals is
 * enforced here rather than left to the database, because a rounding surprise
 * found at INSERT time is a 500 and found here is a readable 400.
 */
const money = z.coerce
  .number()
  .min(-9_999_999)
  .max(9_999_999)
  .refine((n) => Number.isFinite(n) && Math.round(n * 100) === n * 100, {
    message: 'Use at most two decimal places',
  });

const id = z.string().min(1);
const ids = z.array(id).min(1).max(500);
/**
 * The same list, but allowed to be empty.
 *
 * An invoice can legitimately be raised with nothing on it — a customer agreed
 * to be billed this cycle and the work is still being delivered — and jobs are
 * added to it afterwards. Adding jobs is a different act and still demands at
 * least one, because an add of nothing is a mistake rather than an intention.
 */
const maybeIds = z.array(id).max(500);

/** Which delivered, uninvoiced jobs could go on an invoice for this customer. */
export const previewInvoiceSchema = z
  .object({
    clientId: id,
    /** Inclusive both ends, judged on the delivery date. */
    from: z.coerce.date(),
    to: z.coerce.date(),
  })
  .strict();

export const createInvoiceSchema = z
  .object({
    clientId: id,
    /** Defaults to today in the service, which is what the button does. */
    invoiceDate: z.coerce.date().optional(),
    consignmentIds: maybeIds.default([]),
    notes: z.string().trim().max(2000).optional(),
  })
  .strict();

/**
 * Open and close only. Approval is its own endpoint because it stamps a person
 * against a decision, and burying that in a generic PATCH makes it look like
 * an ordinary field change.
 */
export const updateInvoiceSchema = z
  .object({
    status: z.enum(['OPEN', 'CLOSED']).optional(),
    invoiceDate: z.coerce.date().optional(),
    dueDate: z.coerce.date().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

export const addLinesSchema = z.object({ consignmentIds: ids }).strict();

/**
 * Editing one job's money.
 *
 * Only the base-side amounts can be set. Levy and tax are percentages of
 * something else and are always recomputed — letting them be typed over would
 * let an invoice disagree with its own arithmetic.
 */
export const editLineSchema = z
  .object({
    baseAmount: money.optional(),
    distanceAmount: money.optional(),
    waitingAmount: money.optional(),
    /**
     * Corrections to individual service charges, keyed by the price line's own
     * key (`service:<id>`).
     *
     * Only charges an operator ticked can be set this way; one the system added
     * from the clock is refused, because editing it would let the invoice
     * disagree with the rule that produced it. A key that is not on the line,
     * or is not editable, is a 400 rather than a silent no-op.
     */
    serviceAmounts: z
      .array(z.object({ key: z.string().min(1).max(80), amount: money }).strict())
      .max(50)
      .optional(),
    /**
     * Replaces every manual line on this job, rather than appending. One
     * request carries the whole set, so removing a line is expressible — with
     * append-only there is no way to say "take that one back off".
     */
    manualLines: z
      .array(
        z
          .object({ label: z.string().trim().min(1).max(120), amount: money })
          .strict(),
      )
      .max(20)
      .optional(),
  })
  .strict();

export const listInvoicesQuerySchema = z
  .object({
    clientId: id.optional(),
    status: z.enum(['OPEN', 'CLOSED', 'APPROVED']).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    /** Matches an invoice number or a customer name, case-insensitively. */
    q: z.string().trim().max(120).optional(),
  })
  .strict();

export const invoiceIdParamSchema = z.object({ id }).strict();
export const invoiceLineParamSchema = z.object({ id, lineId: id }).strict();

/**
 * Emailing an approved invoice. Up to five addresses each in To and Cc — a
 * customer's accounts team, not a mailing list.
 */
export const sendInvoiceSchema = z
  .object({
    to: z.array(z.email()).min(1, 'Add at least one recipient').max(5),
    cc: z.array(z.email()).max(5).optional(),
    /** An optional line added to the email body above the payment details. */
    message: z.string().trim().max(2000).optional(),
  })
  .strict();

/** Admin-only, and the only place the tax rate and the counter can be moved. */
export const updateFinanceSettingsSchema = z
  .object({
    taxPct: z.coerce.number().min(0).max(100).optional(),
    invoicePrefix: z.string().trim().max(12).optional(),
    invoiceNextNumber: z.coerce.number().int().min(1).max(99_999_999).optional(),
  })
  .strict();

export type PreviewInvoiceInput = z.infer<typeof previewInvoiceSchema>;
export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;
export type UpdateInvoiceInput = z.infer<typeof updateInvoiceSchema>;
export type AddLinesInput = z.infer<typeof addLinesSchema>;
export type EditLineInput = z.infer<typeof editLineSchema>;
export type ListInvoicesQuery = z.infer<typeof listInvoicesQuerySchema>;
export type UpdateFinanceSettingsInput = z.infer<typeof updateFinanceSettingsSchema>;
export type SendInvoiceInput = z.infer<typeof sendInvoiceSchema>;
