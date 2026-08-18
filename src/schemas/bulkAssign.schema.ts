import { z } from 'zod';

/** Bulk assignment is bounded: an unbounded list is an unbounded transaction. */
export const MAX_BULK_ASSIGN = 200;

export const bulkAssignSchema = z
  .object({
    consignmentIds: z
      .array(z.string().min(1))
      .min(1, 'Select at least one order')
      .max(MAX_BULK_ASSIGN, `At most ${MAX_BULK_ASSIGN} orders at a time`),
    driverId: z.string().min(1, 'Driver is required'),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

export type BulkAssignInput = z.infer<typeof bulkAssignSchema>;
