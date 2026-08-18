import { prisma } from '../../config/prisma.js';

/** All Prisma access for routing. */

export interface PickupRow {
  id: string;
  orderNo: string;
  status: string;
  driverId: string | null;
  senderLat: number | null;
  senderLng: number | null;
  senderLine1: string;
  senderArea: string | null;
  senderCity: string;
}

/**
 * Where the driver has to go.
 *
 * The SENDER coordinate, always. Assignment is only possible while an order is
 * UNASSIGNED or ASSIGNED — past that the API refuses to change the driver — so
 * the goods have never been collected and the pickup is the only meaningful
 * target. Ranking against the delivery address would answer a question nobody
 * asked at this point in the flow.
 */
export function findPickup(consignmentId: string) {
  return prisma.consignment.findUnique({
    where: { id: consignmentId },
    select: {
      id: true,
      orderNo: true,
      status: true,
      driverId: true,
      senderLat: true,
      senderLng: true,
      senderLine1: true,
      senderArea: true,
      senderCity: true,
    },
  });
}

/**
 * One driver and where they are now, for drawing a route from them.
 *
 * Deliberately NOT windowed by recency. A position that aged out is still the last
 * place we know of, and refusing to draw a line the moment it turns two minutes old
 * would fail on a normal click — the service returns `staleSeconds` instead and lets
 * the caller caveat it.
 */
export function findDriverWithPosition(driverId: string) {
  return prisma.driver.findUnique({
    where: { id: driverId },
    select: {
      id: true,
      name: true,
      active: true,
      onShift: true,
      position: { select: { lat: true, lng: true, recordedAt: true } },
    },
  });
}

export interface CandidateRow {
  driverId: string;
  name: string;
  code: string | null;
  mobile: string | null;
  colorIndex: number | null;
  activeLoad: number;
  /** Null when the driver is clocked on but has not reported inside the window. */
  lat: number | null;
  lng: number | null;
  recordedAt: Date | null;
  accuracyM: number | null;
}

/**
 * Everyone who could take this job, with their current position and load.
 *
 * Three deliberate choices:
 *
 * - **`d.active AND d."onShift"`** matches the assignment rule exactly. Offering a
 *   driver the API would then refuse with a 409 is worse than not offering them.
 * - **LEFT JOIN on `driver_positions`**, not an inner one. A driver clocked on whose
 *   phone has not reported yet is still assignable — they just cannot be ranked, so
 *   they come back with a null position and the service sorts them last. An inner
 *   join would silently hide them.
 * - **`count(*)::int`** because Postgres counts as bigint, which Prisma hands back as
 *   a BigInt that JSON cannot serialise.
 *
 * This used to be a LATERAL over `driver_locations` picking the newest row per
 * driver. It is a plain join now because `driver_positions` holds exactly one row
 * per driver — the same reason this stays fast at two hundred drivers.
 */
export function findAssignableWithPosition(cutoff: Date) {
  return prisma.$queryRaw<CandidateRow[]>`
    SELECT
      d.id            AS "driverId",
      d.name,
      d.code,
      d.mobile,
      d."mapColorIndex" AS "colorIndex",
      COALESCE(j.open_jobs, 0) AS "activeLoad",
      p.lat,
      p.lng,
      p."recordedAt",
      p."accuracyM"
    FROM drivers d
    LEFT JOIN driver_positions p
      ON p."driverId" = d.id
     AND p."recordedAt" >= ${cutoff}
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS open_jobs
      FROM consignments c
      WHERE c."driverId" = d.id
        AND c.status <> 'DELIVERED'
    ) j ON true
    WHERE d.active AND d."onShift"
    ORDER BY d.name
  `;
}
