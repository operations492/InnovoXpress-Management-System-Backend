import type { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma.js';

/** All Prisma access for GPS tracking. */

/**
 * A ping may name the job it was taken during, and that column has a foreign key
 * to `consignments`. A phone holds its current job in localStorage, so after the
 * order is deleted — a reseed, most often — every ping it sends references a row
 * that no longer exists and the whole batch fails with P2003.
 *
 * Losing the job link is a far better outcome than losing the positions, so an
 * unknown id is dropped rather than rejected.
 */
export async function createPings(rows: Prisma.DriverLocationCreateManyInput[]) {
  const ids = [...new Set(rows.map((r) => r.consignmentId).filter((id): id is string => !!id))];

  const known = new Set(
    ids.length === 0
      ? []
      : (
          await prisma.consignment.findMany({
            where: { id: { in: ids } },
            select: { id: true },
          })
        ).map((c) => c.id),
  );

  const safe = rows.map((row) =>
    row.consignmentId && !known.has(row.consignmentId)
      ? { ...row, consignmentId: null }
      : row,
  );

  return prisma.driverLocation.createMany({ data: safe });
}

export interface LatestLocationRow {
  driverId: string;
  name: string;
  lat: number;
  lng: number;
  accuracyM: number | null;
  speedMps: number | null;
  headingDeg: number | null;
  recordedAt: Date;
}

/**
 * Where everyone is now.
 *
 * Reads `driver_positions`, which holds exactly one row per driver — so this is a
 * scan of the roster, not a DISTINCT ON over a history table that grows by
 * millions of rows. It stays this cheap at two hundred drivers.
 *
 * `onShiftOnly` is bound as a parameter rather than concatenated into the WHERE
 * clause, so this remains one prepared statement and cannot become an injection
 * site.
 *
 * Both conditions still matter, and they mean different things: `d."onShift"` is
 * the driver's stated intent, `recordedAt >= cutoff` is evidence the app is
 * actually running. A driver who clocks on and closes the app has the first and
 * not the second, and must not sit frozen on an operations map.
 */
export function findLivePositions(cutoff: Date, onShiftOnly = true) {
  return prisma.$queryRaw<LatestLocationRow[]>`
    SELECT
      p."driverId", d.name, p.lat, p.lng, p."accuracyM", p."speedMps",
      p."headingDeg", p."recordedAt"
    FROM driver_positions p
    JOIN drivers d ON d.id = p."driverId"
    WHERE p."recordedAt" >= ${cutoff}
      AND d.active
      AND (${onShiftOnly} = false OR d."onShift")
    ORDER BY d.name
  `;
}

export interface PositionRow {
  lat: number;
  lng: number;
  recordedAt: Date;
}

/** The stored position, read BEFORE overwriting it — the yardstick for history. */
export function findPosition(driverId: string) {
  return prisma.driverPosition.findUnique({
    where: { driverId },
    select: { lat: true, lng: true, recordedAt: true },
  });
}

/**
 * Overwrite a driver's current position.
 *
 * Always writes, whatever the fix says, because this row IS the liveness signal —
 * the moment we start filtering it, a parked driver disappears again. Guarded on
 * `recordedAt` so a late-arriving buffered fix cannot overwrite a newer one: a
 * phone that reconnects and flushes out of order would otherwise drag the pin
 * backwards in time.
 */
export function upsertPosition(row: {
  driverId: string;
  lat: number;
  lng: number;
  accuracyM: number | null;
  speedMps: number | null;
  headingDeg: number | null;
  consignmentId: string | null;
  recordedAt: Date;
}) {
  return prisma.$executeRaw`
    INSERT INTO driver_positions
      ("driverId", lat, lng, "accuracyM", "speedMps", "headingDeg",
       "consignmentId", "recordedAt", "updatedAt")
    VALUES
      (${row.driverId}, ${row.lat}, ${row.lng}, ${row.accuracyM}, ${row.speedMps},
       ${row.headingDeg}, ${row.consignmentId}, ${row.recordedAt},
       now() AT TIME ZONE 'utc')
    ON CONFLICT ("driverId") DO UPDATE SET
      lat             = EXCLUDED.lat,
      lng             = EXCLUDED.lng,
      "accuracyM"     = EXCLUDED."accuracyM",
      "speedMps"      = EXCLUDED."speedMps",
      "headingDeg"    = EXCLUDED."headingDeg",
      "consignmentId" = EXCLUDED."consignmentId",
      "recordedAt"    = EXCLUDED."recordedAt",
      "updatedAt"     = now() AT TIME ZONE 'utc'
    WHERE driver_positions."recordedAt" <= EXCLUDED."recordedAt"
  `;
}

/** Oldest first, so the result can be drawn straight as a polyline. */
export function findTrail(
  driverId: string,
  range: { from?: Date; to?: Date },
  limit: number,
) {
  return prisma.driverLocation.findMany({
    where: {
      driverId,
      ...(range.from || range.to
        ? {
            recordedAt: {
              ...(range.from ? { gte: range.from } : {}),
              ...(range.to ? { lte: range.to } : {}),
            },
          }
        : {}),
    },
    orderBy: { recordedAt: 'asc' },
    take: limit,
    select: {
      lat: true,
      lng: true,
      accuracyM: true,
      speedMps: true,
      recordedAt: true,
      consignmentId: true,
    },
  });
}
