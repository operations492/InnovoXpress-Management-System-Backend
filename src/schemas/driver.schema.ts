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

export const myConsignmentsQuerySchema = z
  .object({ includeDelivered: z.enum(['true', 'false']).default('false') })
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

/* -------------------------------------------------------------- roster writes
 * The Drivers tab owns the roster row now. Account creation stays in
 * `user.schema.ts` — a login is a different thing from a courier.
 */
const driverName = z.string().trim().min(1, 'Name is required').max(120);
const driverCode = z.string().trim().min(1).max(20);

export const createDriverSchema = z
  .object({
    name: driverName,
    /** Unique across the roster; a duplicate is a 409 from the database. */
    code: driverCode.optional(),
    mobile: z.string().trim().max(40).optional(),
    email: z.string().trim().max(160).optional(),
  })
  .strict();

export const updateDriverSchema = z
  .object({
    name: driverName.optional(),
    code: driverCode.nullable().optional(),
    mobile: z.string().trim().max(40).nullable().optional(),
    email: z.string().trim().max(160).nullable().optional(),
    /** Deactivating also clocks them off and stamps the shift's end. */
    active: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export const driverIdParamSchema = z.object({ id: z.string().min(1) }).strict();

export const driverDocKindParamSchema = z
  .object({ id: z.string().min(1), kind: z.enum(['photo', 'id-card']) })
  .strict();

export type CreateDriverInput = z.infer<typeof createDriverSchema>;
export type UpdateDriverInput = z.infer<typeof updateDriverSchema>;
