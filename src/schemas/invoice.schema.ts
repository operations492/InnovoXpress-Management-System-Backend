import { z } from 'zod';

/**
 * A test invoice is priced from what the operator typed, not from a stored order,
 * so `distanceKm` arrives in the body. That is deliberate: OSRM degrades to
 * straight-line distance when it is unreachable, which is fine on a map and a
 * billing defect on an invoice. When real orders are priced, the distance must
 * be captured and stored on the order, not re-derived at print time.
 */
export const previewInvoiceSchema = z
  .object({
    clientId: z.string().min(1),
    distanceKm: z.coerce.number().min(0).max(10_000),
    serviceLevelId: z.string().min(1).optional(),
    additionalServiceIds: z.array(z.string().min(1)).max(50).default([]),
    freightItems: z
      .array(
        z
          .object({
            id: z.string().min(1),
            qty: z.coerce.number().int().min(1).max(9_999),
          })
          .strict(),
      )
      .max(100)
      .default([]),
  })
  .strict();

export type PreviewInvoiceInput = z.infer<typeof previewInvoiceSchema>;
