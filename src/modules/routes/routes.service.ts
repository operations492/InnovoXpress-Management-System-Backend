import { AppError } from '../../utils/httpError.js';
import { haversineMetres, plottable, type LatLng } from '../../utils/geo.js';
import type { CreateRouteInput, ReorderRouteInput } from '../../schemas/route.schema.js';
import * as osrm from '../routing/routing.osrm.js';
import * as repo from './routes.repository.js';

/**
 * Planned delivery runs.
 *
 * A route is a PLAN. It records an intended visiting order and nothing else — it
 * gates no status, demands no proof, and modifies no existing table. The consignment
 * lifecycle behaves exactly as it did before this module existed; delete both route
 * tables and the system carries on unchanged.
 *
 * Two rules carry the whole design:
 *
 *  1. **The sequence is stored, the line never is.** "Visit this order seventh" is a
 *     decision, and nothing else in the database records it. Geometry is regenerated
 *     from OSRM on every read, so there is no cache to invalidate and the drawing
 *     cannot disagree with the stops.
 *
 *  2. **The computer suggests, the operator decides.** `/trip` picks an order only
 *     when explicitly asked. `/route` draws whatever order is currently saved and
 *     reports its honest cost even when that is worse — a dispatcher may know about
 *     a gate that closes at five.
 */

const unavailable = (message: string) => new AppError(503, 'SERVICE_UNAVAILABLE', message);

/** Why a stop no longer matches what the plan assumed. Derived on read, never stored. */
export type StopIssue = 'delivered' | 'reassigned' | 'unassigned' | 'address-moved';

/** How far a delivery pin may drift before the plan counts as out of date. */
const DRIFT_TOLERANCE_M = 50;

function assertRoutable(driver: { active: boolean; onShift: boolean; name: string } | null) {
  if (!driver) throw AppError.notFound('Driver not found');
  if (!driver.active) throw AppError.badRequest(`Driver "${driver.name}" is inactive`);
  // The same rule the single assign endpoint enforces: planning work for someone
  // who has gone home is planning work nobody will do.
  if (!driver.onShift) {
    throw AppError.conflict(
      `Driver "${driver.name}" is off shift — they must clock on before taking new work`,
    );
  }
}

/**
 * Turn a saved route into something drawable.
 *
 * Geometry is fetched here, on every read. If OSRM is unreachable the route still
 * comes back — stops, order and stored totals intact — with only the line missing,
 * so a dispatcher can read and reorder a plan while the engine is down.
 */
async function present(route: repo.RouteRow) {
  const stops = route.stops.map((s, i) => {
    const c = s.consignment;

    const issues: StopIssue[] = [];
    if (c.status === 'DELIVERED') issues.push('delivered');
    else if (c.driverId === null) issues.push('unassigned');
    else if (c.driverId !== route.driverId) issues.push('reassigned');

    /*
     * The snapshot earning its keep. A delivery address edited after planning leaves
     * the driver heading somewhere the plan never chose, and comparing the stored
     * coordinates against the order's current ones is the only way to notice —
     * the old value exists nowhere else once the consignment is updated.
     */
    if (
      plottable(c.receiverLat, c.receiverLng) &&
      haversineMetres(
        { lat: s.plannedLat, lng: s.plannedLng },
        { lat: c.receiverLat as number, lng: c.receiverLng as number },
      ) > DRIFT_TOLERANCE_M
    ) {
      issues.push('address-moved');
    }

    return {
      seq: i + 1,
      consignmentId: c.id,
      orderNo: c.orderNo,
      status: c.status,
      priority: c.priority,
      receiverName: c.receiverName,
      receiverLine1: c.receiverLine1,
      receiverProvince: c.receiverProvince,
      receiverCity: c.receiverCity,
      pickupAfter: c.pickupAfter,
      deliverBefore: c.deliverBefore,
      /** Where the plan put this stop, not where the order says it is today. */
      lat: s.plannedLat,
      lng: s.plannedLng,
      issues,
    };
  });

  // The line follows the SAVED order — routeThrough, not optimiseTrip. Using the
  // optimiser here would silently draw a different route than the one on screen.
  const waypoints: LatLng[] = [
    { lat: route.startLat, lng: route.startLng },
    ...stops.map((s) => ({ lat: s.lat, lng: s.lng })),
    ...(route.endLat !== null && route.endLng !== null
      ? [{ lat: route.endLat, lng: route.endLng }]
      : []),
  ];

  let line: osrm.RoadRoute | null = null;
  let geometryError: string | null = null;
  try {
    line = await osrm.routeThrough(waypoints);
  } catch (err) {
    console.warn('[routes] OSRM unavailable while drawing a route:', err);
    geometryError = 'Routing engine unavailable — the order is shown without its line';
  }

  return {
    id: route.id,
    driver: route.driver,
    status: route.status,
    version: route.version,
    start: { lat: route.startLat, lng: route.startLng, label: route.startLabel },
    end:
      route.endLat !== null && route.endLng !== null
        ? { lat: route.endLat, lng: route.endLng, label: route.endLabel }
        : null,
    sequenceSource: route.sequenceSource,
    optimisedAt: route.optimisedAt,
    createdAt: route.createdAt,
    stops,
    /** `[lat, lng]` pairs through the saved order. Empty when OSRM is unreachable. */
    points: line?.points ?? [],
    distanceM: line?.distanceM ?? route.plannedDistanceM,
    durationS: line?.durationS ?? route.plannedDurationS,
    geometryError,
    /** Stops that changed underneath the plan. A flag for a human, never an action. */
    needsReview: stops.some((s) => s.issues.length > 0),
    /** Static road profiles, never live traffic. */
    trafficAware: false,
  };
}

/* ------------------------------------------------------------------ */
/* create                                                              */
/* ------------------------------------------------------------------ */

/**
 * Plan a run.
 *
 * Assignment is deliberately NOT done here. Bulk assign is its own endpoint with its
 * own partial-failure semantics, and folding the two together would produce a route
 * that half-exists when order 37 turns out to be already collected. This requires the
 * orders to belong to the driver already, which the console does first.
 */
export async function createRoute(input: CreateRouteInput, actorId: string) {
  const driver = await repo.findDriver(input.driverId);
  assertRoutable(driver);

  if (input.clientKey) {
    // A double-tapped Save returns the route the first tap made, rather than
    // superseding it with an identical one.
    const existing = await repo.findByClientKey(input.driverId, input.clientKey);
    if (existing) return present(existing);
  }

  if (!plottable(input.start.lat, input.start.lng)) {
    throw AppError.badRequest('The start location is not a usable coordinate');
  }
  if (input.end && !plottable(input.end.lat, input.end.lng)) {
    throw AppError.badRequest('The end location is not a usable coordinate');
  }

  const unique = [...new Set(input.consignmentIds)];
  const orders = await repo.findConsignmentsForRoute(unique);

  const found = new Map(orders.map((o) => [o.id, o]));
  const missing = unique.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw AppError.badRequest(`${missing.length} of the selected orders no longer exist`);
  }

  /*
   * Refuse the whole request rather than quietly planning around the problems, and
   * always name the offenders: with fifty selected, "some of these cannot be routed"
   * tells an operator nothing they can act on.
   */
  const unpinned = orders.filter((o) => !plottable(o.receiverLat, o.receiverLng));
  if (unpinned.length > 0) {
    throw AppError.conflict(
      `${unpinned.length} order(s) have no delivery pin and cannot be routed: ` +
        unpinned.map((o) => o.orderNo).join(', '),
    );
  }

  const notTheirs = orders.filter((o) => o.driverId !== input.driverId);
  if (notTheirs.length > 0) {
    throw AppError.conflict(
      `${notTheirs.length} order(s) are not assigned to ${driver!.name} — assign them first: ` +
        notTheirs.map((o) => o.orderNo).join(', '),
    );
  }

  const delivered = orders.filter((o) => o.status === 'DELIVERED');
  if (delivered.length > 0) {
    throw AppError.conflict(
      `${delivered.length} order(s) are already delivered: ` +
        delivered.map((o) => o.orderNo).join(', '),
    );
  }

  /*
   * Ask the optimiser for an order. Index 0 is the start and, when an end was named,
   * the last index is that — both are pinned, so only the drops in between move.
   */
  const points: LatLng[] = [
    { lat: input.start.lat, lng: input.start.lng },
    ...orders.map((o) => ({ lat: o.receiverLat as number, lng: o.receiverLng as number })),
    ...(input.end ? [{ lat: input.end.lat, lng: input.end.lng }] : []),
  ];

  let plan: osrm.TripPlan | null;
  try {
    plan = await osrm.optimiseTrip(points, { fixedEnd: !!input.end });
  } catch (err) {
    console.warn('[routes] OSRM unavailable while optimising:', err);
    throw unavailable(
      'The routing engine is unavailable, so an optimal order cannot be worked out right now',
    );
  }

  /*
   * `plan.order` holds INPUT indices in visiting order. Index 0 is the start and the
   * last is the end when there is one; dropping those leaves the drops, and index i
   * maps to orders[i - 1] because the start occupies slot 0.
   *
   * When OSRM can find no tour at all, fall back to the selection order rather than
   * discarding the operator's work — a route in a poor order can be re-optimised, a
   * lost selection of fifty cannot.
   */
  const endIndex = input.end ? points.length - 1 : -1;
  const ordered = plan
    ? plan.order.filter((i) => i !== 0 && i !== endIndex).map((i) => orders[i - 1])
    : orders;

  const routeId = await repo.createRoute({
    driverId: input.driverId,
    start: input.start,
    end: input.end,
    createdById: actorId,
    clientKey: input.clientKey,
    plannedDistanceM: plan?.distanceM ?? null,
    plannedDurationS: plan?.durationS ?? null,
    stops: ordered.map((o) => ({
      consignmentId: o.id,
      plannedLat: o.receiverLat as number,
      plannedLng: o.receiverLng as number,
    })),
  });

  return present((await repo.findById(routeId))!);
}

/* ------------------------------------------------------------------ */
/* read, reorder, optimise, clear                                      */
/* ------------------------------------------------------------------ */

/** What the DRIVERS tab loads. Null when the driver has no live plan. */
export async function activeRoute(driverId: string) {
  const route = await repo.findActiveByDriver(driverId);
  return route ? present(route) : null;
}

/**
 * Apply an operator's order.
 *
 * Strictly a permutation: the submitted list must be exactly the current stops,
 * rearranged. Allowing additions or removals here would change what the driver is
 * carrying under the guise of dragging a row.
 */
export async function reorder(routeId: string, input: ReorderRouteInput) {
  const route = await repo.findById(routeId);
  if (!route) throw AppError.notFound('Route not found');
  if (route.status !== 'ACTIVE') throw AppError.conflict('That route is no longer active');

  const current = new Set(route.stops.map((s) => s.consignmentId));
  const submitted = new Set(input.consignmentIds);

  if (
    submitted.size !== input.consignmentIds.length ||
    submitted.size !== current.size ||
    [...submitted].some((id) => !current.has(id))
  ) {
    throw AppError.badRequest(
      'A reorder must contain exactly the stops already on the route, each once',
    );
  }

  const ok = await repo.reorderStops(routeId, input.version, input.consignmentIds, true);
  if (!ok) {
    throw AppError.conflict('This route changed while you were editing it — reload and try again');
  }

  const updated = await present((await repo.findById(routeId))!);
  // Keep the stored totals honest with the order actually saved.
  if (updated.distanceM !== null && updated.durationS !== null) {
    await repo.setPlannedTotals(routeId, updated.distanceM, updated.durationS);
  }
  return updated;
}

/**
 * What the optimiser would do instead — a PREVIEW, applied only if asked.
 *
 * Silently re-optimising a hand-made order is how a driver ends up doubling back and
 * stops trusting the plan, so this returns the proposal and the difference and
 * changes nothing. Accepting it is a normal reorder.
 */
export async function optimisePreview(routeId: string) {
  const route = await repo.findById(routeId);
  if (!route) throw AppError.notFound('Route not found');
  if (route.status !== 'ACTIVE') throw AppError.conflict('That route is no longer active');

  const current = await present(route);

  const points: LatLng[] = [
    { lat: route.startLat, lng: route.startLng },
    ...route.stops.map((s) => ({ lat: s.plannedLat, lng: s.plannedLng })),
    ...(route.endLat !== null && route.endLng !== null
      ? [{ lat: route.endLat, lng: route.endLng }]
      : []),
  ];

  let plan: osrm.TripPlan | null;
  try {
    plan = await osrm.optimiseTrip(points, { fixedEnd: route.endLat !== null });
  } catch (err) {
    console.warn('[routes] OSRM unavailable while previewing an optimisation:', err);
    throw unavailable('The routing engine is unavailable right now');
  }
  if (!plan) throw AppError.conflict('No order could be worked out for these stops');

  const endIndex = route.endLat !== null ? points.length - 1 : -1;
  const proposed = plan.order
    .filter((i) => i !== 0 && i !== endIndex)
    .map((i) => route.stops[i - 1].consignmentId);

  const unchanged =
    proposed.length === route.stops.length &&
    proposed.every((id, i) => id === route.stops[i].consignmentId);

  return {
    routeId,
    /** Send this back to PATCH /sequence to accept the proposal. */
    consignmentIds: proposed,
    version: route.version,
    unchanged,
    current: { distanceM: current.distanceM, durationS: current.durationS },
    proposed: { distanceM: plan.distanceM, durationS: plan.durationS },
    saves: {
      distanceM: (current.distanceM ?? 0) - plan.distanceM,
      durationS: (current.durationS ?? 0) - plan.durationS,
    },
  };
}

/** Retire a driver's plan. The orders keep their assignment — only the plan goes. */
export async function clearRoute(driverId: string) {
  const res = await repo.closeActiveForDriver(driverId);
  if (res.count === 0) throw AppError.notFound('That driver has no active route');
  return { cleared: true };
}
