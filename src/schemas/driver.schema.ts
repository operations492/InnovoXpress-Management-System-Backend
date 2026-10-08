import { z } from 'zod';

// driverSessionSchema is gone with the password-free sign-in it validated.
// Drivers now authenticate against Supabase like everyone else.

const pingSchema = z
  .object({
    lat: z.coerce.number().min(-90).max(90),
    lng: z.coerce.number().min(-180).max(180),
    /** Metres of uncertainty from the device, when it reports one. */
    accuracyM: z.coerce.number().min(0).max(100_000).optional(),
    speedMps: z.coerce.number().min(0).max(200).optional(),
    headingDeg: z.coerce.number().min(0).max(360).optional(),
    consignmentId: z.string().min(1).optional(),
    /** The device's own timestamp, so a buffered ping keeps its real time. */
    recordedAt: z.coerce.date().optional(),
  })
  .strict();

/**
 * A batch, not a single point. A courier's phone loses signal constantly, so the
 * app buffers pings offline and flushes them when it reconnects — one request
 * per point would drop most of the trail.
 */
export const recordLocationsSchema = z
  .object({ pings: z.array(pingSchema).min(1).max(200) })
  .strict();

/**
 * A driver's own work list.
 *
 * `scope` splits the list along the line that actually matters — whether the
 * slice is bounded. A driver's live run is a handful of jobs and is fetched
 * whole; their delivered history grows for as long as they work here, so it is
 * the only part that is ever paged.
 *
 * `includeDelivered` is kept for the older clients that still send it, and is
 * read only when `scope` is absent. The two never combine: `scope` is the newer,
 * more precise question, so it wins outright rather than being intersected with
 * a flag that means something slightly different.
 *
 * `page`/`pageSize` are optional everywhere. Omit them and the response is
 * exactly what it has always been — a bare `{ data }` with no envelope — so
 * adding paging here breaks nothing that already works.
 */
export const myConsignmentsQuerySchema = z
  .object({
    includeDelivered: z.enum(['true', 'false']).default('false'),
    scope: z.enum(['live', 'delivered']).optional(),
    page: z.coerce.number().int().positive().optional(),
    // Capped: this is a phone on a mobile uplink, and an unbounded pageSize
    // would hand back the very thing paging exists to avoid.
    pageSize: z.coerce.number().int().positive().max(100).optional(),
  })
  .strict();

/**
 * GET /api/drivers/locations/latest
 *
 * `withinMinutes` has NO default on purpose. The real default lives in
 * POSITION_LIVE_SECONDS and is measured in seconds, because the phone now reports
 * every few seconds whether it is moving or not — a minute-scale default here would
 * silently override it and put stale pins back on the map.
 */
export const latestLocationsQuerySchema = z
  .object({
    withinMinutes: z.coerce.number().int().min(1).max(1440).optional(),
    /** Set to 'false' to see everyone reporting, clocked on or not. */
    onShiftOnly: z.enum(['true', 'false']).default('true'),
  })
  .strict();

export const trailQuerySchema = z
  .object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    limit: z.coerce.number().int().min(1).max(5000).default(1000),
  })
  .strict();

export type RecordLocationsInput = z.infer<typeof recordLocationsSchema>;
export type TrailQuery = z.infer<typeof trailQuerySchema>;
export type LatestLocationsQuery = z.infer<typeof latestLocationsQuerySchema>;
