import { env } from '../../config/env.js';
import type { LatLng } from '../../utils/geo.js';

/**
 * The OSRM client.
 *
 * One module owns every call to the routing engine, so the two things that are
 * easy to get wrong live in exactly one place:
 *
 *   1. **OSRM takes `lon,lat`, not `lat,lng`.** Swapping them does not error — it
 *      quietly routes you into the Indian Ocean and returns plausible numbers.
 *   2. **It is an external process that can be down.** Every caller must be able
 *      to degrade, so failures arrive as one recognisable error type rather than
 *      as a fetch error, a JSON parse error or a shape mismatch.
 *
 * Nothing here throws AppError: this layer does not know whether being unable to
 * reach OSRM is fatal for the request. That is the service's call.
 */

/** OSRM could not be reached, timed out, or answered with something unusable. */
export class OsrmUnavailableError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'OsrmUnavailableError';
  }
}

/** A leg's cost. `null` when OSRM found no road connection at all. */
export interface Leg {
  distanceM: number;
  durationS: number;
}

/** `lon,lat` — see the note above. */
const coord = (p: LatLng) => `${p.lng},${p.lat}`;

async function getJson(
  path: string,
  /**
   * Payload `code`s to hand back instead of throwing.
   *
   * OSRM reports "I understood you and there is no answer" — `NoRoute`,
   * `NoSegment` — through the same field it uses for real faults, and the two need
   * opposite handling. No road connection is a fact about the map and belongs in
   * the response; an unreachable engine is an outage the caller must degrade around.
   */
  allowCodes: string[] = [],
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(`${env.OSRM_URL}${path}`, {
      // Node's own timeout signal: no dependency, and it aborts the socket rather
      // than leaving it dangling.
      signal: AbortSignal.timeout(env.OSRM_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
  } catch (cause) {
    // Connection refused, DNS failure, or the timeout firing all land here.
    throw new OsrmUnavailableError(`Could not reach OSRM at ${env.OSRM_URL}`, cause);
  }

  if (!res.ok) {
    throw new OsrmUnavailableError(`OSRM answered ${res.status} for ${path}`);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (cause) {
    throw new OsrmUnavailableError('OSRM returned a body that is not JSON', cause);
  }

  if (typeof body !== 'object' || body === null) {
    throw new OsrmUnavailableError('OSRM returned an unexpected body');
  }

  const obj = body as Record<string, unknown>;
  // OSRM reports its own failures in the payload with HTTP 200 — `NoRoute`,
  // `NoSegment`, `TooBig`. Treating those as success would hand callers an
  // undefined matrix.
  if (obj.code !== 'Ok' && !allowCodes.includes(String(obj.code))) {
    throw new OsrmUnavailableError(`OSRM refused the request: ${String(obj.code)}`);
  }

  return obj;
}

/** A drawable road route. */
export interface RoadRoute {
  /** `[lat, lng]` pairs, ready for Leaflet. Flipped from OSRM's own order here. */
  points: [number, number][];
  distanceM: number;
  durationS: number;
}

/**
 * The roads between two points.
 *
 * `/route`, not `/table`: the matrix service returns numbers only, which is exactly
 * why it can rank a whole roster in one call. Geometry costs one request per pair,
 * so this is fetched for a driver the operator has actually selected.
 *
 * Returns `null` when OSRM says there is no road connection — a fact about the map,
 * not a failure. An unreachable engine still throws.
 */
export async function routeTo(from: LatLng, to: LatLng): Promise<RoadRoute | null> {
  const body = await getJson(
    `/route/v1/driving/${coord(from)};${coord(to)}` +
      // geojson rather than the default encoded polyline: no decoder needed on
      // either side, and the payload is a couple of KB for a city route.
      `?overview=full&geometries=geojson&steps=false&alternatives=false`,
    ['NoRoute', 'NoSegment'],
  );

  if (body.code !== 'Ok') return null;

  const routes = body.routes as
    | Array<{ geometry?: { coordinates?: [number, number][] }; distance?: number; duration?: number }>
    | undefined;
  const route = routes?.[0];
  const coords = route?.geometry?.coordinates;

  if (!route || !Array.isArray(coords) || coords.length < 2) return null;

  return {
    // OSRM speaks [lon, lat]; Leaflet wants [lat, lng]. Flipped once, here, so no
    // caller can get it wrong — a silent swap draws a plausible line in the Indian
    // Ocean rather than raising anything.
    points: coords.map(([lng, lat]) => [lat, lng] as [number, number]),
    distanceM: route.distance ?? 0,
    durationS: route.duration ?? 0,
  };
}

/**
 * Drive time and road distance from many origins to ONE destination, in a single
 * request.
 *
 * This is the whole reason the nearest-driver question is cheap: ranking 25
 * drivers costs one HTTP call, not 25. The URL carries every coordinate, so it
 * grows with the shortlist — around 20 characters each, which keeps a few hundred
 * origins inside any sane URL limit but is a reason to shortlist before calling.
 */
export async function matrixTo(origins: LatLng[], destination: LatLng): Promise<(Leg | null)[]> {
  if (origins.length === 0) return [];

  const points = [...origins, destination].map(coord).join(';');
  const sources = origins.map((_, i) => i).join(';');
  const destinationIndex = origins.length;

  const body = await getJson(
    `/table/v1/driving/${points}` +
      `?sources=${sources}&destinations=${destinationIndex}` +
      `&annotations=duration,distance`,
  );

  // Shape: durations[originIndex][0], because there is exactly one destination.
  const durations = body.durations as (number | null)[][] | undefined;
  const distances = body.distances as (number | null)[][] | undefined;

  if (!Array.isArray(durations) || durations.length !== origins.length) {
    throw new OsrmUnavailableError('OSRM returned a matrix of the wrong size');
  }

  return origins.map((_, i) => {
    const durationS = durations[i]?.[0] ?? null;
    // `distances` needs OSRM built with distance annotations. If this build lacks
    // them the ranking still works — duration is what we sort on.
    const distanceM = distances?.[i]?.[0] ?? null;

    if (durationS === null) return null;
    return { durationS, distanceM: distanceM ?? 0 };
  });
}

/**
 * OSRM's cap for the trip (optimisation) service, `max-trip-size`. Measured on this
 * server: 100 coordinates succeed, 101 answers `TooBig`. Start + 95 stops + an
 * optional end therefore fits with headroom.
 */
export const TRIP_MAX_POINTS = 100;

/**
 * Draw the roads through these points IN THIS ORDER.
 *
 * The read path, and the half of the pair that never argues. Whatever sequence it
 * is handed — the optimiser's or one a dispatcher dragged into place — it returns
 * the line and the honest cost of exactly that. A slower order produces a bigger
 * number rather than a quiet correction.
 *
 * Measured: 126 waypoints in ~300ms, no cap hit. That is why route geometry is
 * regenerated on every read instead of being stored.
 */
export async function routeThrough(points: LatLng[]): Promise<RoadRoute | null> {
  if (points.length < 2) return null;

  const body = await getJson(
    `/route/v1/driving/${points.map(coord).join(';')}` +
      `?overview=full&geometries=geojson&steps=false&alternatives=false`,
    ['NoRoute', 'NoSegment'],
  );
  if (body.code !== 'Ok') return null;

  const route = (
    body.routes as
      | Array<{ geometry?: { coordinates?: [number, number][] }; distance?: number; duration?: number }>
      | undefined
  )?.[0];
  const coords = route?.geometry?.coordinates;
  if (!route || !Array.isArray(coords) || coords.length < 2) return null;

  return {
    points: coords.map(([lng, lat]) => [lat, lng] as [number, number]),
    distanceM: route.distance ?? 0,
    durationS: route.duration ?? 0,
  };
}

/** What the optimiser proposes: an order, and what it costs. */
export interface TripPlan {
  /** Indices into the input array, in the order they should be visited. */
  order: number[];
  distanceM: number;
  durationS: number;
}

/**
 * Choose the best order to visit these points — the other half of the pair.
 *
 * `source=first` pins the start (the depot), `roundtrip=false` means the driver does
 * not return to it, and `destination=last` pins the finish when the operator named
 * one. Without an end, OSRM is free to finish wherever is cheapest.
 *
 * A heuristic, not a proof: it solves the travelling-salesman problem by insertion,
 * landing within a few percent of optimal in milliseconds. It also has no idea about
 * `deliverBy` — it minimises driving time and nothing else.
 */
export async function optimiseTrip(
  points: LatLng[],
  opts: { fixedEnd: boolean },
): Promise<TripPlan | null> {
  if (points.length < 2) return null;
  if (points.length > TRIP_MAX_POINTS) {
    throw new OsrmUnavailableError(
      `Too many stops for one route: ${points.length} (max ${TRIP_MAX_POINTS})`,
    );
  }

  const body = await getJson(
    `/trip/v1/driving/${points.map(coord).join(';')}` +
      `?source=first&roundtrip=false${opts.fixedEnd ? '&destination=last' : ''}` +
      `&overview=false&geometries=geojson`,
    ['NoTrips', 'NoSegment'],
  );
  if (body.code !== 'Ok') return null;

  const trip = (body.trips as Array<{ distance?: number; duration?: number }> | undefined)?.[0];
  const waypoints = body.waypoints as Array<{ waypoint_index?: number } | null> | undefined;
  if (!trip || !Array.isArray(waypoints) || waypoints.length !== points.length) return null;

  /*
   * OSRM answers positionally: waypoints[i].waypoint_index is where input i lands in
   * the tour. Inverting that gives the visiting order as input indices, which is what
   * a caller can map back to its own stops. Reading it the other way round silently
   * produces a valid-looking but wrong sequence.
   */
  const order: number[] = new Array(points.length).fill(-1);
  for (let i = 0; i < waypoints.length; i += 1) {
    const at = waypoints[i]?.waypoint_index;
    if (typeof at !== 'number' || at < 0 || at >= points.length) return null;
    order[at] = i;
  }
  if (order.some((i) => i === -1)) return null;

  return { order, distanceM: trip.distance ?? 0, durationS: trip.duration ?? 0 };
}
