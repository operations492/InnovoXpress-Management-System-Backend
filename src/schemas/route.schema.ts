import { z } from 'zod';

/**
 * A pinned place. Both halves are required together — a label with no coordinates
 * is an address someone typed but never placed on the map, and a route cannot be
 * planned around it.
 */
const place = z
  .object({
    lat: z.coerce.number().min(-90).max(90),
    lng: z.coerce.number().min(-180).max(180),
    label: z.string().trim().max(200).optional(),
  })
  .strict();

/**
 * How many drops one route may hold.
 *
 * OSRM's trip service caps at 100 coordinates (measured: 101 answers `TooBig`), and
 * the start — plus an end, when given — occupy two of them. 95 leaves headroom
 * rather than failing at exactly the boundary.
 */
export const MAX_ROUTE_STOPS = 95;

export const createRouteSchema = z
  .object({
    driverId: z.string().min(1, 'A driver is required'),
    consignmentIds: z
      .array(z.string().min(1))
      .min(2, 'A route needs at least two stops')
      .max(MAX_ROUTE_STOPS, `A route can hold at most ${MAX_ROUTE_STOPS} stops`),
    /** Where the driver collects everything. Mandatory: a run starts somewhere. */
    start: place,
    /** Optional finish. Absent means "end at the last drop". */
    end: place.optional(),
    /** Idempotency — a double-tapped Save must not create two routes. */
    clientKey: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

/**
 * A reorder is a PERMUTATION, never an edit of membership.
 *
 * Adding or dropping stops here would quietly change what the driver is carrying
 * under the guise of moving a row, so the service rejects any list that is not
 * exactly the current stops rearranged.
 */
export const reorderRouteSchema = z
  .object({
    consignmentIds: z.array(z.string().min(1)).min(2),
    /** The version the client was looking at. Mismatch is a 409, not a silent win. */
    version: z.coerce.number().int().min(1),
  })
  .strict();

export const routeIdParamSchema = z.object({ id: z.string().min(1) }).strict();
export const driverIdParamSchema = z.object({ driverId: z.string().min(1) }).strict();

export type CreateRouteInput = z.infer<typeof createRouteSchema>;
export type ReorderRouteInput = z.infer<typeof reorderRouteSchema>;
