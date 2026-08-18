import { z } from 'zod';

/**
 * GET /api/consignments/:id/nearest-drivers
 *
 * `withinMinutes` matches the live map's default for a reason: "who can I send"
 * and "who is on the map" must be the same set of people, or an operator sees a
 * driver they cannot pick, or picks one who has vanished.
 */
export const nearestDriversQuerySchema = z
  .object({
    withinMinutes: z.coerce.number().int().min(1).max(1440).default(3),
    /**
     * Keep drivers with no recent ping in the response, ranked last. They are
     * genuinely assignable — clocked on, just not reporting yet — so hiding them
     * would make the list shorter than the roster with no explanation.
     */
    includeUnlocated: z.enum(['true', 'false']).default('true'),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export type NearestDriversQuery = z.infer<typeof nearestDriversQuerySchema>;

/**
 * GET /api/consignments/:id/driver-route
 *
 * The driver is a query parameter rather than a second path segment so the existing
 * `consignmentIdParamSchema` still validates the params on its own.
 */
export const driverRouteQuerySchema = z
  .object({ driverId: z.string().min(1) })
  .strict();

export type DriverRouteQuery = z.infer<typeof driverRouteQuerySchema>;
