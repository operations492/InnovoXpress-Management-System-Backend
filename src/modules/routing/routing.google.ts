/**
 * The Google Routes client — the routing engine.
 *
 * Replaces the self-hosted OSRM client and keeps its exact interface, so the two
 * services that depend on it did not change their logic: same functions, same
 * shapes, and the same contract that a missing road returns `null` while an
 * unreachable engine throws. Callers already degrade correctly around that.
 *
 * Four things are easy to get wrong here, so they live in exactly one place:
 *
 *   1. **Google bills per call AND per field.** The `X-Goog-FieldMask` header
 *      decides the SKU, so every request asks for the narrowest set that answers
 *      the question. OSRM was free and this system was written to call it on
 *      every read; that assumption is now a line item, which is why there is a
 *      cache and a daily budget below.
 *   2. **It is an external service that can be down, throttled or over budget.**
 *      All three arrive as one recognisable error, exactly as OSRM's outages did.
 *   3. **GeoJSON output is `[lon, lat]`, Leaflet wants `[lat, lng]`.** Flipped
 *      once, here. A silent swap draws a plausible line in the wrong hemisphere.
 *   4. **`optimizeWaypointOrder` always needs a destination**, where OSRM could
 *      finish wherever was cheapest. See `optimiseTrip`.
 *
 * Nothing here throws AppError: this layer does not know whether being unable to
 * reach the engine is fatal for the request. That is the service's call.
 */
import { env } from '../../config/env.js';
import type { LatLng } from '../../utils/geo.js';

const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const MATRIX_URL = 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix';

/**
 * The engine could not be reached, timed out, refused us, or the day's budget is
 * spent. Named for the role, not the vendor — swapping provider again should not
 * ripple into every catch block.
 */
export class RoutingUnavailableError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'RoutingUnavailableError';
  }
}

/** Kept so anything naming the old error still compiles. */
export const OsrmUnavailableError = RoutingUnavailableError;

/** A leg's cost. `null` when there is no road connection at all. */
export interface Leg {
  distanceM: number;
  durationS: number;
}

/** A drawable road route. */
export interface RoadRoute {
  /** `[lat, lng]` pairs, ready for Leaflet. Flipped from GeoJSON order here. */
  points: [number, number][];
  distanceM: number;
  durationS: number;
}

/** What the optimiser proposes: an order, and what it costs. */
export interface TripPlan {
  /** Indices into the input array, in the order they should be visited. */
  order: number[];
  distanceM: number;
  durationS: number;
}

/**
 * Google's cap on intermediate waypoints, and **far below OSRM's 100**.
 *
 * This is a real behaviour change: a planned route that used to take 95 stops now
 * refuses past this. Raise `GOOGLE_ROUTES_MAX_WAYPOINTS` if the account's plan
 * allows more, rather than editing this.
 */
export const TRIP_MAX_POINTS = env.GOOGLE_ROUTES_MAX_WAYPOINTS;

/**
 * Whether the numbers this engine returns account for live traffic.
 *
 * Exported because the API tells operators so in `meta.trafficAware`, and that
 * field was hard-coded `false` for OSRM. It must track the real setting or it is
 * worse than no field at all.
 */
export const TRAFFIC_AWARE = env.GOOGLE_ROUTES_TRAFFIC !== 'TRAFFIC_UNAWARE';

/* ----------------------------------------------------------------- spending */

/**
 * A day's call budget, counted in process.
 *
 * Not a billing guarantee — a circuit breaker. The failure mode of a runaway loop
 * against a metered API is a bill rather than an error, and a bill is the one
 * failure nobody notices until the month ends. When the budget is gone the engine
 * simply reads as unavailable, and every caller already degrades for that.
 */
let spentOn = '';
let spent = 0;

function chargeOne() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== spentOn) {
    spentOn = today;
    spent = 0;
  }
  if (spent >= env.GOOGLE_ROUTES_DAILY_BUDGET) {
    throw new RoutingUnavailableError(
      `Routing budget for today is spent (${env.GOOGLE_ROUTES_DAILY_BUDGET} calls)`,
    );
  }
  spent += 1;
}

/** Calls charged today. For tests, and for an admin read-out later. */
export function callsToday(): number {
  return new Date().toISOString().slice(0, 10) === spentOn ? spent : 0;
}

/* -------------------------------------------------------------------- cache */

/**
 * A TTL cache in front of the engine, and the single biggest saving here.
 *
 * OSRM was free, so a saved route regenerated its line on every read — one
 * operator leaving a route page open all afternoon would bill a call per poll.
 * Identical requests inside the TTL answer from memory, and concurrent identical
 * requests share one in-flight promise, so a double-click costs once.
 *
 * In-process on purpose: it is the right size for one dispatch office, it cannot
 * go stale in a way that matters (a road does not move in an hour), and a deploy
 * or a second instance simply pays once more.
 */
const cache = new Map<string, { at: number; ttl: number; value: unknown }>();
const inFlight = new Map<string, Promise<unknown>>();

function cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return Promise.resolve(hit.value as T);

  const running = inFlight.get(key);
  if (running) return running as Promise<T>;

  const promise = load()
    .then((value) => {
      cache.set(key, { at: Date.now(), ttl, value });
      // Unbounded growth is the other way to lose money quietly.
      if (cache.size > 500) {
        for (const k of [...cache.keys()].slice(0, 100)) cache.delete(k);
      }
      return value;
    })
    .finally(() => inFlight.delete(key));

  inFlight.set(key, promise);
  return promise;
}

/** Six decimals is ~10cm — precise enough to key on, coarse enough to ever hit. */
const key = (p: LatLng) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;

/** Drops everything. Tests only — a process restart is the real reset. */
export function clearRoutingCache() {
  cache.clear();
  inFlight.clear();
}

/* --------------------------------------------------------------------- wire */

const latLng = (p: LatLng) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });

/** Google returns durations as a protobuf duration string: `"1234s"`. */
export function seconds(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const n = Number.parseFloat(v.endsWith('s') ? v.slice(0, -1) : v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

async function post(
  url: string,
  fieldMask: string,
  body: unknown,
  /** Retried once: a 429 or a 503 is usually a moment, not a fault. */
  retry = true,
): Promise<unknown> {
  if (!env.GOOGLE_ROUTES_API_KEY) {
    // No key, no network call: the app can be deployed before the key exists and
    // degrades instead of burning a timeout on every request.
    throw new RoutingUnavailableError('GOOGLE_ROUTES_API_KEY is not configured');
  }

  chargeOne();

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(env.GOOGLE_ROUTES_TIMEOUT_MS),
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'X-Goog-Api-Key': env.GOOGLE_ROUTES_API_KEY,
        // The whole cost story in one header: Google rejects the request without
        // it, and bills according to what it names.
        'X-Goog-FieldMask': fieldMask,
      },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    throw new RoutingUnavailableError('Could not reach the Google Routes API', cause);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    // A 4xx is our bug — bad key, bad body, quota ceiling. Retrying spends money
    // to receive the same answer.
    if (retry && (res.status === 429 || res.status >= 500)) {
      return post(url, fieldMask, body, false);
    }
    throw new RoutingUnavailableError(
      `Google Routes answered ${res.status}: ${detail.slice(0, 200)}`,
    );
  }

  try {
    return await res.json();
  } catch (cause) {
    throw new RoutingUnavailableError('Google Routes returned a body that is not JSON', cause);
  }
}

interface GoogleRoute {
  distanceMeters?: number;
  duration?: string;
  polyline?: { geoJsonLinestring?: { coordinates?: [number, number][] } };
  optimizedIntermediateWaypointIndex?: number[];
}

function firstRoute(body: unknown): GoogleRoute | null {
  const routes = (body as { routes?: GoogleRoute[] } | null)?.routes;
  return Array.isArray(routes) && routes.length > 0 ? (routes[0] ?? null) : null;
}

function toRoadRoute(route: GoogleRoute): RoadRoute | null {
  const coords = route.polyline?.geoJsonLinestring?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;

  return {
    // GeoJSON is [lon, lat]; Leaflet wants [lat, lng]. Flipped once, here.
    points: coords.map(([lng, lat]) => [lat, lng] as [number, number]),
    distanceM: route.distanceMeters ?? 0,
    durationS: seconds(route.duration),
  };
}

/**
 * GeoJSON rather than Google's default encoded polyline: no decoder to write or
 * trust, and it is the same `[lon, lat]` shape OSRM returned, so the flip above
 * is the one that was already proven in production.
 */
const GEOMETRY_MASK = 'routes.distanceMeters,routes.duration,routes.polyline.geoJsonLinestring';
const ORDER_MASK =
  'routes.distanceMeters,routes.duration,routes.optimizedIntermediateWaypointIndex';

function routeBody(
  origin: LatLng,
  destination: LatLng,
  intermediates: LatLng[],
  extra: Record<string, unknown> = {},
) {
  return {
    origin: latLng(origin),
    destination: latLng(destination),
    ...(intermediates.length ? { intermediates: intermediates.map(latLng) } : {}),
    travelMode: 'DRIVE',
    routingPreference: env.GOOGLE_ROUTES_TRAFFIC,
    units: 'METRIC',
    ...extra,
  };
}

/**
 * Polyline options, for the calls that actually want a line.
 *
 * Deliberately NOT a default on every request: Google rejects the whole call with
 * `INVALID_ARGUMENT` — "No polyline is requested via field mask but polyline
 * quality is specified" — when these are sent alongside a field mask that asks
 * for no geometry. `optimiseTrip` asks for none on purpose, because geometry is a
 * pricier SKU and the order is all it needs.
 */
const POLYLINE = {
  polylineEncoding: 'GEO_JSON_LINESTRING',
  polylineQuality: 'OVERVIEW',
} as const;

/**
 * Turn Google's optimised intermediate order into indices of OUR input array.
 *
 * Google answers with positions among the INTERMEDIATES only: entry j holds the
 * index of the intermediate it visits j-th, zero-based among intermediates. Our
 * callers index into the whole array, where slot 0 is the start — so everything
 * shifts by one and the pinned ends are added back. Reading it the other way
 * round produces a valid-looking but wrong sequence, which is why it is a pure
 * function with a test rather than three lines inside a fetch handler.
 *
 * Exported for that test only.
 */
export function mapOptimisedOrder(
  optimised: number[],
  total: number,
  fixedEnd: boolean,
): number[] | null {
  const expected = fixedEnd ? total - 2 : total - 1;
  if (optimised.length !== expected) return null;
  if (optimised.some((i) => !Number.isInteger(i) || i < 0 || i >= expected)) return null;

  const order = [0, ...optimised.map((i) => i + 1), ...(fixedEnd ? [total - 1] : [])];
  // A duplicate or a gap means we misread the response; better no plan than a
  // plan that drops a delivery.
  return new Set(order).size === total ? order : null;
}

/* ------------------------------------------------------------------ exports */

/**
 * The roads between two points.
 *
 * Returns `null` when there is no road connection — a fact about the map, not a
 * failure. An unreachable engine still throws.
 */
export async function routeTo(from: LatLng, to: LatLng): Promise<RoadRoute | null> {
  return cached(`to:${key(from)}:${key(to)}`, env.GOOGLE_ROUTES_CACHE_TTL_MS, async () => {
    const body = await post(ROUTES_URL, GEOMETRY_MASK, routeBody(from, to, [], POLYLINE));
    const route = firstRoute(body);
    return route ? toRoadRoute(route) : null;
  });
}

/**
 * Drive time and road distance from many origins to ONE destination, in a single
 * request.
 *
 * Still one call for the whole roster, which is what makes the nearest-driver
 * question affordable. The field mask deliberately omits geometry: ranking needs
 * numbers, and a line per driver would multiply both the payload and the price.
 *
 * Shorter TTL than geometry, because drivers move.
 */
export async function matrixTo(origins: LatLng[], destination: LatLng): Promise<(Leg | null)[]> {
  if (origins.length === 0) return [];

  return cached(
    `matrix:${origins.map(key).join('|')}>${key(destination)}`,
    env.GOOGLE_MATRIX_CACHE_TTL_MS,
    async () => {
      const body = await post(
        MATRIX_URL,
        'originIndex,destinationIndex,duration,distanceMeters,condition',
        {
          origins: origins.map((p) => ({ waypoint: latLng(p) })),
          destinations: [{ waypoint: latLng(destination) }],
          travelMode: 'DRIVE',
          routingPreference: env.GOOGLE_ROUTES_TRAFFIC,
        },
      );

      if (!Array.isArray(body)) {
        throw new RoutingUnavailableError('Google Routes returned an unexpected matrix');
      }

      /*
       * Rebuilt BY INDEX, never by arrival order. The matrix endpoint streams
       * cells in whatever order it finishes them, and the caller joins
       * `legs[i]` to `origins[i]` positionally — so trusting the response order
       * would quietly pair drivers with other drivers' ETAs.
       */
      const out: (Leg | null)[] = new Array(origins.length).fill(null);
      for (const cell of body as Array<{
        originIndex?: number;
        duration?: string;
        distanceMeters?: number;
        condition?: string;
      }>) {
        const i = cell.originIndex ?? -1;
        if (!Number.isInteger(i) || i < 0 || i >= origins.length) continue;
        // ROUTE_NOT_FOUND is the equivalent of OSRM's null cell: a real answer
        // about the map. Left null so the caller ranks it last rather than
        // treating it as "zero seconds away".
        if (cell.condition && cell.condition !== 'ROUTE_EXISTS') continue;
        out[i] = { durationS: seconds(cell.duration), distanceM: cell.distanceMeters ?? 0 };
      }
      return out;
    },
  );
}

/**
 * Draw the roads through these points IN THIS ORDER.
 *
 * The read path, and the half of the pair that never argues. Whatever sequence it
 * is handed — the optimiser's or one a dispatcher dragged into place — it returns
 * the line and the honest cost of exactly that. A slower order produces a bigger
 * number rather than a quiet correction.
 */
export async function routeThrough(points: LatLng[]): Promise<RoadRoute | null> {
  if (points.length < 2) return null;
  if (points.length - 2 > TRIP_MAX_POINTS) {
    throw new RoutingUnavailableError(
      `Too many stops for one route: ${points.length - 2} (max ${TRIP_MAX_POINTS})`,
    );
  }

  return cached(`through:${points.map(key).join('|')}`, env.GOOGLE_ROUTES_CACHE_TTL_MS, async () => {
    const body = await post(
      ROUTES_URL,
      GEOMETRY_MASK,
      routeBody(points[0]!, points[points.length - 1]!, points.slice(1, -1), POLYLINE),
    );
    const route = firstRoute(body);
    return route ? toRoadRoute(route) : null;
  });
}

/**
 * Choose the best order to visit these points — the other half of the pair.
 *
 * **The one place Google is not a drop-in.** `optimizeWaypointOrder` only moves
 * intermediates, so it always needs a destination, where OSRM's `roundtrip=false`
 * with no `destination` could finish wherever was cheapest. With no end named we
 * therefore send the start as the destination too — a closed tour — and simply
 * ignore the drive home. That costs a little optimality versus pinning an
 * arbitrary final stop, which would be worse: it would silently decide that
 * whichever order the operator happened to select last is where the day ends.
 *
 * Deliberately asks for no geometry and no live traffic. Ordering is a one-off
 * decision that needs neither, both cost more, and the honest traffic-aware cost
 * comes from the `routeThrough` call that follows.
 */
export async function optimiseTrip(
  points: LatLng[],
  opts: { fixedEnd: boolean },
): Promise<TripPlan | null> {
  if (points.length < 2) return null;

  const stops = opts.fixedEnd ? points.length - 2 : points.length - 1;
  if (stops > TRIP_MAX_POINTS) {
    throw new RoutingUnavailableError(
      `Too many stops for one route: ${stops} (max ${TRIP_MAX_POINTS})`,
    );
  }
  // Nothing to permute: two points have exactly one order.
  if (stops <= 1) {
    return { order: points.map((_, i) => i), distanceM: 0, durationS: 0 };
  }

  const origin = points[0]!;
  const destination = opts.fixedEnd ? points[points.length - 1]! : origin;
  const intermediates = opts.fixedEnd ? points.slice(1, -1) : points.slice(1);

  return cached(
    `trip:${opts.fixedEnd ? 'end' : 'open'}:${points.map(key).join('|')}`,
    env.GOOGLE_ROUTES_CACHE_TTL_MS,
    async () => {
      const body = await post(
        ROUTES_URL,
        ORDER_MASK,
        routeBody(origin, destination, intermediates, {
          optimizeWaypointOrder: true,
          routingPreference: 'TRAFFIC_UNAWARE',
        }),
      );

      const route = firstRoute(body);
      if (!route || !Array.isArray(route.optimizedIntermediateWaypointIndex)) return null;

      const order = mapOptimisedOrder(
        route.optimizedIntermediateWaypointIndex,
        points.length,
        opts.fixedEnd,
      );
      if (!order) return null;

      /*
       * The totals are only honest when the end was pinned. With an open end we
       * asked for a closed tour, so Google's distance and duration include the
       * drive back to the start that we then throw away - measured at 17.2 km
       * against the real 10.4 km on a four-stop Toronto run. Reporting zero keeps
       * that number out of the database; the true cost of the saved order comes
       * from the `routeThrough` call the caller makes straight afterwards.
       */
      return {
        order,
        distanceM: opts.fixedEnd ? (route.distanceMeters ?? 0) : 0,
        durationS: opts.fixedEnd ? seconds(route.duration) : 0,
      };
    },
  );
}
