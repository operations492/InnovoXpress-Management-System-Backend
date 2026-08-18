import { env } from '../../config/env.js';
import { AppError } from '../../utils/httpError.js';
import { haversineMetres } from '../../utils/geo.js';
import type { RecordLocationsInput, TrailQuery, LatestLocationsQuery } from '../../schemas/driver.schema.js';
import * as driversRepo from '../drivers/drivers.repository.js';
import * as repo from './locations.repository.js';

/**
 * GPS tracking.
 *
 * Its own module rather than part of `drivers`: it owns a separate table, a
 * different write pattern (high-frequency append-only), and a retention job.
 */

/**
 * Store a batch of pings for one driver.
 *
 * Pings are expected in chronological order — a phone buffers while offline and
 * flushes oldest-first.
 *
 * Any ping without its own timestamp is stamped one millisecond apart, ending at
 * "now", rather than giving the whole batch an identical time. Identical
 * timestamps make "the driver's latest position" ambiguous, and the live map
 * would then show an arbitrary point from the batch instead of the newest one.
 */
export async function recordLocations(driverId: string, input: RecordLocationsInput) {
  const now = Date.now();
  const total = input.pings.length;

  const rows = input.pings.map((p, i) => ({
    driverId,
    lat: p.lat,
    lng: p.lng,
    accuracyM: p.accuracyM ?? null,
    speedMps: p.speedMps ?? null,
    headingDeg: p.headingDeg ?? null,
    consignmentId: p.consignmentId ?? null,
    // A device clock can be wrong or deliberately set forward; never accept a
    // timestamp from the future.
    recordedAt:
      p.recordedAt && p.recordedAt.getTime() <= now
        ? p.recordedAt
        : new Date(now - (total - 1 - i)),
  }));

  /*
   * One request, two destinations — and this split is the whole point.
   *
   * The LIVE POSITION takes the newest fix unconditionally. It is the answer to
   * "is this driver online", so filtering it is what made a parked courier vanish.
   *
   * HISTORY takes only fixes that represent real movement. A phone on a dashboard
   * reports its own GPS jitter every few seconds, and writing that would bloat the
   * table and turn every stop into a scribble on the trail.
   *
   * The comparison starts from the STORED position — read before the overwrite —
   * so a driver who parks and reports for an hour adds one history row, not one per
   * batch. Within the batch it then walks cumulatively from the last kept point.
   */
  const previous = await repo.findPosition(driverId);
  let anchor: { lat: number; lng: number } | null = previous;
  const history = rows.filter((row) => {
    if (anchor && haversineMetres(anchor, row) < env.HISTORY_MIN_MOVE_M) return false;
    anchor = { lat: row.lat, lng: row.lng };
    return true;
  });

  if (history.length > 0) await repo.createPings(history);

  const newest = rows[rows.length - 1];
  await repo.upsertPosition(newest);

  return {
    // What went into the trail. The live position always updates, so a batch that
    // reports zero here is still a driver we can see.
    accepted: history.length,
    position: { lat: newest.lat, lng: newest.lng, recordedAt: newest.recordedAt },
  };
}

/**
 * Who is out there right now — the console's live map.
 *
 * "Live" needs BOTH halves and neither is sufficient alone. `onShift` is intent,
 * but it goes stale: a driver can clock on, close the app and walk away, leaving
 * a flag set and a frozen pin. Recency is evidence the app is genuinely open and
 * reporting, but says nothing about whether they meant to be working. Together
 * they mean "clocked on and actually reporting", and the map self-heals — stop
 * reporting and you drop off within the window.
 *
 * Recency is now a real signal rather than a proxy for movement. It reads
 * `driver_positions`, which is overwritten on every report, so a stationary driver
 * stays live — under the old history-backed version they went quiet and vanished.
 *
 * `withinMinutes` stays for callers that pass it; the default comes from
 * POSITION_LIVE_SECONDS, which is expressed in seconds because the meaningful
 * window is now well under a minute of reporting interval.
 */
export async function latestLocations(q?: LatestLocationsQuery) {
  const windowMs = q?.withinMinutes
    ? q.withinMinutes * 60_000
    : env.POSITION_LIVE_SECONDS * 1000;
  const onShiftOnly = (q?.onShiftOnly ?? 'true') === 'true';

  const cutoff = new Date(Date.now() - windowMs);
  return {
    data: await repo.findLivePositions(cutoff, onShiftOnly),
    meta: { withinSeconds: Math.round(windowMs / 1000), onShiftOnly },
  };
}

/** The path a driver took. */
export async function driverTrail(driverId: string, q: TrailQuery) {
  const driver = await driversRepo.findDriverById(driverId);
  if (!driver) throw AppError.notFound('Driver not found');

  const rows = await repo.findTrail(driverId, { from: q.from, to: q.to }, q.limit);

  return {
    driver,
    retentionDays: env.LOCATION_RETENTION_DAYS,
    count: rows.length,
    data: rows,
  };
}
