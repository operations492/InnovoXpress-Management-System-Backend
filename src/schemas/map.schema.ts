import { z } from 'zod';
import { MAP_TABS } from '../constants/mapTabs.js';

/*
 * Every object is .strict(), as everywhere else in this API — an unknown query
 * parameter is a 400 rather than a filter that silently does nothing.
 */

/** Circuit breaker, not a page size. Hitting it means something is wrong. */
export const MAP_PIN_HARD_LIMIT = 5000;

const csv = (schema: z.ZodString) =>
  z
    .union([schema, z.array(schema)])
    .transform((v) => (Array.isArray(v) ? v : v.split(',')))
    .transform((ids) => ids.map((s) => s.trim()).filter((s) => s.length > 0));

export const mapPinsQuerySchema = z
  .object({
    tab: z.enum(MAP_TABS as [string, ...string[]]).optional(),

    /**
     * Plural from the start. "Show me these three drivers" needs no API change
     * later, and a single id is just an array of one.
     */
    driverIds: csv(z.string().min(1)).optional(),

    clientId: z.string().min(1).optional(),
    q: z.string().trim().min(1).max(100).optional(),

    /**
     * The map's time axis is `deliverBy`, NOT `createdAt`.
     *
     * The consignments list filters on createdAt, which for a map would drop an
     * order created Monday for Tuesday delivery out of a Tuesday view. Send
     * instants, resolved from the operator's own timezone — the server must not
     * infer a day boundary, because `inclusiveEnd()` in the consignments
     * repository reads server-local time.
     */
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),

    /**
     * Include deliveries completed since this instant. Defaults to the start of
     * the caller's day if omitted, so the board shows open work plus today's
     * completions rather than every consignment ever delivered.
     */
    completedSince: z.coerce.date().optional(),

    limit: z.coerce.number().int().min(1).max(MAP_PIN_HARD_LIMIT).default(MAP_PIN_HARD_LIMIT),
  })
  .strict()
  .refine((v) => !(v.from && v.to) || v.from <= v.to, {
    message: 'from must not be after to',
  });

export const mapDriversQuerySchema = z
  .object({
    /** Include drivers who are deactivated but still hold open work. */
    includeInactive: z.enum(['true', 'false']).default('true'),
  })
  .strict();

export type MapPinsQuery = z.infer<typeof mapPinsQuerySchema>;
export type MapDriversQuery = z.infer<typeof mapDriversQuerySchema>;
