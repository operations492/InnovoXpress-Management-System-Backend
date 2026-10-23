import { z } from 'zod';

/** Money in, rounded to cents so a float from JSON cannot carry 0.005 into a total. */
const money = z.coerce
  .number()
  .min(0, 'Cannot be negative')
  .max(99_999_999.99)
  .transform((v) => Math.round(v * 100) / 100);

const km = z.coerce.number().int().min(0).max(10_000);

const name = z.string().trim().min(1, 'Name is required').max(120);

export const createRatePlanSchema = z
  .object({
    name,
    clientId: z.string().min(1),
    /** Default true. Pass false to draft a replacement while the current plan stays live. */
    active: z.boolean().optional(),
  })
  .strict();

/** Every field optional — the base-rate tab PATCHes whichever boxes changed. */
export const updateRatePlanSchema = z
  .object({
    name: name.optional(),
    active: z.boolean().optional(),
    currency: z.string().trim().length(3).toUpperCase().optional(),
    baseRate: money.optional(),
    includedKm: km.optional(),
    /** The quote divides by this, so zero is refused here and by a CHECK. */
    blockKm: z.coerce.number().int().min(1).max(10_000).optional(),
    blockRate: money.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

/**
 * One row of the price grid. Exactly one catalogue id, mirroring the CHECK on the
 * table: pricing two things in one row is not a thing that can be expressed.
 */
export const ratePlanItemSchema = z
  .object({
    serviceLevelId: z.string().min(1).optional(),
    additionalServiceId: z.string().min(1).optional(),
    freightItemId: z.string().min(1).optional(),
    price: money,
  })
  .strict()
  .refine(
    (v) =>
      [v.serviceLevelId, v.additionalServiceId, v.freightItemId].filter(Boolean).length === 1,
    { message: 'Set exactly one of serviceLevelId, additionalServiceId or freightItemId' },
  );

/**
 * The whole grid in one call. Rows present are priced; rows left out are not
 * priced at all, which is different from a row priced at 0 (deliberately free).
 */
export const setRatePlanItemsSchema = z
  .object({ items: z.array(ratePlanItemSchema).max(500) })
  .strict();

export const ratePlanIdParamSchema = z.object({ id: z.string().min(1) }).strict();

export const listRatePlansQuerySchema = z
  .object({
    clientId: z.string().min(1).optional(),
    includeInactive: z.enum(['true', 'false']).default('false'),
  })
  .strict();

export type CreateRatePlanInput = z.infer<typeof createRatePlanSchema>;
export type UpdateRatePlanInput = z.infer<typeof updateRatePlanSchema>;
export type SetRatePlanItemsInput = z.infer<typeof setRatePlanItemsSchema>;
export type ListRatePlansQuery = z.infer<typeof listRatePlansQuerySchema>;
