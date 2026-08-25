import { AppError } from '../../utils/httpError.js';
import { haversineMetres, plottable, type LatLng } from '../../utils/geo.js';
import type { DriverRouteQuery, NearestDriversQuery } from '../../schemas/routing.schema.js';
import * as osrm from './routing.osrm.js';
import * as repo from './routing.repository.js';

/**
 * Which driver should take this job.
 *
 * The problem Uber solves with a hexagonal spatial index and we solve with a
 * WHERE clause: with a roster of eight, filtering is free and the only interesting
 * part is the ranking.
 *
 * Two stages, and the split matters:
 *
 *   1. **Shortlist in SQL** — on shift, active, and pinged recently. Cheap, and it
 *      matches the assignment rule so nobody is offered who would be refused.
 *   2. **Rank by road time** — one OSRM matrix call for the whole shortlist.
 *
 * Straight-line distance is NOT good enough for step 2 and that is the whole point
 * of the OSRM call: on real Lahore geometry a driver 12.2 km away arrived sooner
 * than one 14.3 km away, because the further one was on a better road. Ranking on
 * crow-flies distance would have inverted them.
 */

/** What sorting on `durationS` means when OSRM could not answer. */
export type RankSource = 'osrm' | 'straight-line' | 'none';

export interface RankedDriver {
  driverId: string;
  name: string;
  code: string | null;
  mobile: string | null;
  colorIndex: number | null;
  activeLoad: number;
  /** Null for a driver clocked on who has not reported inside the window. */
  lat: number | null;
  lng: number | null;
  recordedAt: Date | null;
  accuracyM: number | null;
  /** How old the position is. Lets the UI say "4s ago" instead of implying "now". */
  staleSeconds: number | null;
  /** Road seconds when ranked by OSRM; null when unknown or unreachable. */
  durationS: number | null;
  /** Road metres from OSRM, or straight-line metres in the fallback. */
  distanceM: number | null;
  /** True when this row was measured, false when it is only listed. */
  ranked: boolean;
}

/** Why there is no line to draw. `null` when there is one. */
export type NoRouteReason = 'no-position' | 'no-road-route' | 'engine-unavailable';

/**
 * The roads one driver would take to reach this order's pickup.
 *
 * The companion to `nearestDrivers`, and the split is structural rather than a
 * choice: `/table` answers "how far is everyone" in one call but returns no
 * geometry, and `/route` returns geometry but only for one pair. So the ranking is
 * fetched for the whole roster and the line only for the driver an operator has
 * actually picked.
 *
 * Never throws for an absent line. "This driver is not reporting" and "OSRM is
 * down" are both normal things to be told mid-click, so they come back as a 200
 * with `available: false` and a reason — a 404 on selecting a name would read as
 * the console being broken.
 */
export async function driverRoute(consignmentId: string, q: DriverRouteQuery) {
  const order = await repo.findPickup(consignmentId);
  if (!order) throw AppError.notFound('Consignment not found');

  if (!plottable(order.senderLat, order.senderLng)) {
    throw AppError.conflict(
      `Order ${order.orderNo} has no pickup coordinates, so no route can be drawn`,
    );
  }

  const driver = await repo.findDriverWithPosition(q.driverId);
  // A driver id that does not exist IS a caller error, unlike the cases below.
  if (!driver) throw AppError.notFound('Driver not found');

  const pickup: LatLng = { lat: order.senderLat as number, lng: order.senderLng as number };

  const base = {
    driver: { id: driver.id, name: driver.name, onShift: driver.onShift, active: driver.active },
    pickup: {
      lat: pickup.lat,
      lng: pickup.lng,
      line1: order.senderLine1,
      province: order.senderProvince,
      city: order.senderCity,
    },
    orderNo: order.orderNo,
    /** Static road profiles, never live traffic — as everywhere else here. */
    trafficAware: false,
  };

  const unavailable = (reason: NoRouteReason, warning: string) => ({
    ...base,
    available: false as const,
    reason,
    warning,
    from: null,
    points: [],
    distanceM: null,
    durationS: null,
    staleSeconds: null,
  });

  if (!driver.position || !plottable(driver.position.lat, driver.position.lng)) {
    return unavailable('no-position', `${driver.name} has not reported a position yet`);
  }

  const from: LatLng = { lat: driver.position.lat, lng: driver.position.lng };
  const staleSeconds = Math.max(
    0,
    Math.round((Date.now() - driver.position.recordedAt.getTime()) / 1000),
  );

  let route: Awaited<ReturnType<typeof osrm.routeTo>>;
  try {
    route = await osrm.routeTo(from, pickup);
  } catch (err) {
    console.warn('[routing] OSRM unavailable for driver route:', err);
    return unavailable('engine-unavailable', 'Routing engine unavailable — no route to draw');
  }

  if (!route) {
    // Genuinely no road connection: a fix snapped to the wrong side of a river, or
    // an address pinned in the middle of a field.
    return unavailable('no-road-route', 'No road route between the driver and this pickup');
  }

  return {
    ...base,
    available: true as const,
    reason: null,
    warning: null,
    from: { lat: from.lat, lng: from.lng, recordedAt: driver.position.recordedAt },
    /** `[lat, lng]` pairs, ready to hand straight to a Leaflet Polyline. */
    points: route.points,
    distanceM: route.distanceM,
    durationS: route.durationS,
    /**
     * Age of the position the route starts from. The line is only as current as
     * this, and an operator should see that rather than infer it.
     */
    staleSeconds,
  };
}

export async function nearestDrivers(consignmentId: string, q: NearestDriversQuery) {
  const order = await repo.findPickup(consignmentId);
  if (!order) throw AppError.notFound('Consignment not found');

  if (!plottable(order.senderLat, order.senderLng)) {
    // A real state, not a bug: the pickup address was never pinned. Say so plainly
    // rather than returning an arbitrary order — the operator needs to fix the
    // address, and a silently unranked list would hide that.
    throw AppError.conflict(
      `Order ${order.orderNo} has no pickup coordinates, so drivers cannot be ranked by distance`,
    );
  }

  const pickup: LatLng = { lat: order.senderLat as number, lng: order.senderLng as number };

  const cutoff = new Date(Date.now() - q.withinMinutes * 60_000);
  const candidates = await repo.findAssignableWithPosition(cutoff);

  const located = candidates.filter((c) => plottable(c.lat, c.lng));
  const unlocated = candidates.filter((c) => !plottable(c.lat, c.lng));

  let legs: (osrm.Leg | null)[] = [];
  let source: RankSource = 'none';
  let warning: string | null = null;

  if (located.length > 0) {
    const origins: LatLng[] = located.map((c) => ({ lat: c.lat as number, lng: c.lng as number }));
    try {
      legs = await osrm.matrixTo(origins, pickup);
      source = 'osrm';
    } catch (err) {
      /*
       * OSRM being down must not break assignment. Fall back to straight-line so
       * the operator still gets a sensible ordering, and SAY SO in the response —
       * a silent downgrade would have them trusting a number that ignores the
       * canal, the railway and every one-way street.
       */
      legs = origins.map((o) => ({ durationS: 0, distanceM: haversineMetres(o, pickup) }));
      source = 'straight-line';
      warning =
        'Routing engine unavailable — distances are straight-line, not driving distance';
      console.warn('[routing] OSRM unavailable, fell back to straight-line:', err);
    }
  }

  const now = Date.now();
  const staleness = (at: Date | null) =>
    at ? Math.max(0, Math.round((now - at.getTime()) / 1000)) : null;

  const rankedRows: RankedDriver[] = located.map((c, i) => {
    const leg = legs[i] ?? null;
    return {
      driverId: c.driverId,
      name: c.name,
      code: c.code,
      mobile: c.mobile,
      colorIndex: c.colorIndex,
      activeLoad: c.activeLoad,
      lat: c.lat,
      lng: c.lng,
      recordedAt: c.recordedAt,
      accuracyM: c.accuracyM,
      staleSeconds: staleness(c.recordedAt),
      // In the straight-line fallback duration is meaningless, so it stays null
      // rather than being faked from an assumed speed.
      durationS: source === 'osrm' ? (leg?.durationS ?? null) : null,
      distanceM: leg?.distanceM ?? null,
      ranked: leg !== null,
    };
  });

  /*
   * Sort key, in order: anyone we could measure, then by the measurement, then by
   * load, then by name.
   *
   * `load` breaks ties on purpose — two drivers 30 seconds apart are effectively
   * equidistant, and the one carrying less work is the better answer. Name last so
   * the list never reshuffles arbitrarily between polls.
   */
  const measure = (d: RankedDriver) =>
    source === 'osrm' ? d.durationS : d.distanceM;

  rankedRows.sort((a, b) => {
    if (a.ranked !== b.ranked) return a.ranked ? -1 : 1;
    const ma = measure(a);
    const mb = measure(b);
    if (ma !== null && mb !== null && ma !== mb) return ma - mb;
    if (a.activeLoad !== b.activeLoad) return a.activeLoad - b.activeLoad;
    return a.name.localeCompare(b.name);
  });

  const unlocatedRows: RankedDriver[] =
    q.includeUnlocated === 'false'
      ? []
      : unlocated.map((c) => ({
          driverId: c.driverId,
          name: c.name,
          code: c.code,
          mobile: c.mobile,
          colorIndex: c.colorIndex,
          activeLoad: c.activeLoad,
          lat: null,
          lng: null,
          recordedAt: null,
          accuracyM: null,
          staleSeconds: null,
          durationS: null,
          distanceM: null,
          ranked: false,
        }));

  const data = [...rankedRows, ...unlocatedRows].slice(0, q.limit);

  return {
    data,
    meta: {
      consignmentId: order.id,
      orderNo: order.orderNo,
      pickup: {
        lat: pickup.lat,
        lng: pickup.lng,
        line1: order.senderLine1,
        province: order.senderProvince,
        city: order.senderCity,
      },
      /** What `durationS`/`distanceM` actually mean — the UI must not guess. */
      source,
      warning,
      withinMinutes: q.withinMinutes,
      /** On shift and reporting, so rankable. */
      rankedCount: rankedRows.filter((d) => d.ranked).length,
      /** On shift but not reporting — assignable, just not measurable. */
      unlocatedCount: unlocated.length,
      totalCandidates: candidates.length,
      /**
       * OSRM durations come from OpenStreetMap speed profiles, never live traffic.
       * The ordering is trustworthy; the clock is optimistic at peak hours.
       */
      trafficAware: false,
    },
  };
}
