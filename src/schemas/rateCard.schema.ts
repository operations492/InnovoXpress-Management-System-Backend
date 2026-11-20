import { z } from 'zod';

/*
 * A rate card and the five numbers that price one route through it.
 *
 * The five are deliberately all there is: a base rate, the distance it covers,
 * the rate beyond that, the waiting time it covers, and the rate beyond that.
 * Quantity, weight and minimum-charge tiers exist in other systems and are not
 * modelled here, so no field can be set that nothing reads.
 */

const name = z.string().trim().min(1, 'Name is required').max(80);
const memo = z.string().trim().max(500);

/** numeric(12,2) — money. */
const amount = z.coerce.number().min(0).max(9_999_999.99);
/** numeric(12,4) — a rate applied per kilometre or per minute. */
const perUnit = z.coerce.number().min(0).max(99_999.9999);
/** numeric(8,2) — a distance in kilometres. */
const km = z.coerce.number().min(0).max(999_999.99);
const minutes = z.coerce.number().int().min(0).max(100_000);
/** numeric(5,2) — a percentage, 50 meaning 50%. Matched by a CHECK in the database. */
const percent = z.coerce.number().min(0).max(100);

export const createRateCardSchema = z
  .object({
    name,
    clientId: z.string().min(1),
    zoneListId: z.string().min(1),
    validFrom: z.coerce.date(),
    validTo: z.coerce.date(),
    memo: memo.optional(),
    levyPct: percent.optional(),
  })
  .strict()
  .refine((v) => v.validTo >= v.validFrom, {
    message: 'The expiry date cannot be before the effective date',
    path: ['validTo'],
  });

/**
 * The zone list can still be changed while the card has no rates; the service
 * refuses once it does, because every stored route points into the old list.
 */
export const updateRateCardSchema = z
  .object({
    name: name.optional(),
    zoneListId: z.string().min(1).optional(),
    validFrom: z.coerce.date().optional(),
    validTo: z.coerce.date().optional(),
    memo: memo.nullable().optional(),
    active: z.boolean().optional(),
    levyPct: percent.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

/**
 * One cell of the grid, written whole. There is no PATCH for a single number:
 * the five are read together when a job is priced, so they are written together.
 */
export const putRouteRateSchema = z
  .object({
    serviceLevelId: z.string().min(1),
    freightItemId: z.string().min(1),
    /** Where the job is going. Where it came from does not change the price. */
    toZoneId: z.string().min(1),
    baseRate: amount.default(0),
    freeKm: km.default(0),
    ratePerKm: perUnit.default(0),
    freeWaitMinutes: minutes.default(0),
    waitRatePerMinute: perUnit.default(0),
  })
  .strict();

/**
 * One customer's flat price for one additional service.
 *
 * `rate` is nullable, and sending null is how a card goes back to the catalogue
 * price: the override row is deleted rather than stored as a row of nulls, so
 * "same as standard" has one representation.
 */
export const putCardServiceSchema = z
  .object({
    additionalServiceId: z.string().min(1),
    rate: amount.nullable().optional(),
  })
  .strict();

/**
 * A dry run of one card: what a job would cost, with nothing stored.
 *
 * Distance and waiting are typed in rather than measured. The point is to test
 * the price book, not the road, and a Routes call would put a bill on every
 * keystroke of a what-if.
 */
export const quoteSchema = z
  .object({
    /** Context only: the price is decided by the destination alone. */
    pickupPostalCode: z.string().trim().min(1).max(12).optional(),
    deliveryPostalCode: z.string().trim().min(1).max(12),
    serviceLevelId: z.string().min(1),
    /**
     * Optional, because matching is loose: a rate whose service level and zone
     * match still applies when nobody said what is being carried. Refusing to
     * quote would be the stricter answer and the less useful one.
     */
    freightItemId: z.string().min(1).optional(),
    distanceKm: km.default(0),
    waitMinutes: minutes.default(0),
    additionalServiceIds: z.array(z.string().min(1)).max(50).default([]),
    /** Which day to judge the card's window against. Defaults to today. */
    on: z.coerce.date().optional(),
    /**
     * Sales tax on the sub total, as a percentage. Passed in rather than read
     * from settings, because tax depends on the customer's exemption and on
     * the jurisdiction — neither of which is the rate card's business. Zero,
     * the default, leaves the quote untaxed.
     */
    taxPct: percent.default(0),
  })
  .strict();

export const cardServiceParamSchema = z
  .object({ id: z.string().min(1), serviceId: z.string().min(1) })
  .strict();

export const rateCardIdParamSchema = z.object({ id: z.string().min(1) }).strict();

export const rateParamSchema = z
  .object({ id: z.string().min(1), rateId: z.string().min(1) })
  .strict();

export const listRateCardsQuerySchema = z
  .object({
    clientId: z.string().min(1).optional(),
    includeInactive: z.enum(['true', 'false']).default('false'),
  })
  .strict();

/** The editor asks for one service level and freight item at a time. */
export const listRatesQuerySchema = z
  .object({
    serviceLevelId: z.string().min(1).optional(),
    freightItemId: z.string().min(1).optional(),
  })
  .strict();

export type CreateRateCardInput = z.infer<typeof createRateCardSchema>;
export type UpdateRateCardInput = z.infer<typeof updateRateCardSchema>;
export type PutRouteRateInput = z.infer<typeof putRouteRateSchema>;
export type PutCardServiceInput = z.infer<typeof putCardServiceSchema>;
export type ListRateCardsQuery = z.infer<typeof listRateCardsQuerySchema>;
export type ListRatesQuery = z.infer<typeof listRatesQuerySchema>;
export type QuoteInput = z.infer<typeof quoteSchema>;
