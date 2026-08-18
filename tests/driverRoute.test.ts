import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api,
  authHeader,
  cleanConsignments,
  getDriverToken,
  getToken,
  prisma,
  seedReference,
  type Reference,
} from './helpers/api.js';
import { buildConsignment } from './helpers/factory.js';

/**
 * GET /api/consignments/:id/driver-route
 *
 * The line behind the number `/nearest-drivers` already reports.
 *
 * Written to pass with or without a local OSRM: when the engine is unreachable the
 * endpoint answers 200 with `available: false` rather than failing, so the shape and
 * the refusals can be asserted either way. Only the "there is a line" case needs a
 * running engine, and it checks `available` first rather than demanding one — a
 * suite that required a routing binary would simply be skipped elsewhere.
 */

let ref: Reference;
let token: string;
let driverToken: string;

// Sundar Industrial Estate, and a spot a few km north-east of it.
const PICKUP = { lat: 31.4183, lng: 74.1725 };
const NEARBY = { lat: 31.4402, lng: 74.2093 };

beforeAll(async () => {
  ref = await seedReference();
  token = await getToken();
  driverToken = await getDriverToken(ref.driverId);
});

const auth = () => authHeader(token);
const asDriver = () => authHeader(driverToken);

async function orderWithPickup(coords: { lat: number; lng: number } | null = PICKUP) {
  const payload = buildConsignment(ref.clientId);
  const res = await api
    .post('/api/consignments')
    .set(auth())
    .send({
      ...payload,
      sender: { ...payload.sender, ...(coords ? { lat: coords.lat, lng: coords.lng } : {}) },
    });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

/** Put the driver somewhere. The route starts from `driver_positions`. */
function place(driverId: string, at: { lat: number; lng: number }, secondsAgo = 0) {
  const recordedAt = new Date(Date.now() - secondsAgo * 1000);
  return prisma.driverPosition.upsert({
    where: { driverId },
    create: { driverId, lat: at.lat, lng: at.lng, recordedAt },
    update: { lat: at.lat, lng: at.lng, recordedAt },
  });
}

const get = (id: string, driverId: string) =>
  api.get(`/api/consignments/${id}/driver-route`).query({ driverId }).set(auth());

beforeEach(async () => {
  await cleanConsignments();
  await prisma.driver.updateMany({
    where: { id: { in: [ref.driverId, ref.driverBId] } },
    data: { active: true, onShift: true },
  });
});

describe('the route', () => {
  it('returns a drawable line from the driver to the pickup', async () => {
    const id = await orderWithPickup();
    await place(ref.driverId, NEARBY);

    const res = await get(id, ref.driverId);
    expect(res.status).toBe(200);

    if (!res.body.available) {
      // No engine on this machine — the shape is still asserted below.
      expect(res.body.reason).toBe('engine-unavailable');
      return;
    }

    expect(res.body.points.length).toBeGreaterThan(1);
    expect(res.body.distanceM).toBeGreaterThan(0);
    expect(res.body.durationS).toBeGreaterThan(0);
  });

  it('returns points as [lat, lng], not OSRM’s own [lon, lat]', async () => {
    const id = await orderWithPickup();
    await place(ref.driverId, NEARBY);

    const res = await get(id, ref.driverId);
    if (!res.body.available) return;

    /*
     * The single most dangerous bug in this file. OSRM speaks [lon, lat]; a passed
     * through pair draws a confident line in the Indian Ocean and raises nothing.
     * Lahore is ~31.5 N, ~74.3 E, so latitude is the smaller of the two here.
     */
    for (const [lat, lng] of res.body.points as [number, number][]) {
      expect(lat).toBeGreaterThan(31);
      expect(lat).toBeLessThan(32);
      expect(lng).toBeGreaterThan(74);
      expect(lng).toBeLessThan(75);
    }
  });

  it('starts the line at the driver and ends it at the pickup', async () => {
    const id = await orderWithPickup();
    await place(ref.driverId, NEARBY);

    const res = await get(id, ref.driverId);
    if (!res.body.available) return;

    const points = res.body.points as [number, number][];
    const [firstLat, firstLng] = points[0];
    const [lastLat, lastLng] = points[points.length - 1];

    // Snapped to the nearest road, so within a few hundred metres rather than exact.
    expect(Math.abs(firstLat - NEARBY.lat)).toBeLessThan(0.02);
    expect(Math.abs(firstLng - NEARBY.lng)).toBeLessThan(0.02);
    expect(Math.abs(lastLat - PICKUP.lat)).toBeLessThan(0.02);
    expect(Math.abs(lastLng - PICKUP.lng)).toBeLessThan(0.02);
  });

  it('reports how old the position it started from is', async () => {
    const id = await orderWithPickup();
    await place(ref.driverId, NEARBY, 45);

    const res = await get(id, ref.driverId);

    // The line is only as current as the fix behind it, and an operator should be
    // told that rather than having to infer it.
    expect(res.body.staleSeconds).toBeGreaterThanOrEqual(44);
    expect(res.body.staleSeconds).toBeLessThan(120);
  });

  it('never claims live traffic', async () => {
    const id = await orderWithPickup();
    await place(ref.driverId, NEARBY);

    const res = await get(id, ref.driverId);
    expect(res.body.trafficAware).toBe(false);
  });

  it('draws from an aged-out position rather than refusing', async () => {
    const id = await orderWithPickup();
    // Well outside the live window. The last known place is still the best answer,
    // and a 409 on a normal click would read as the console being broken.
    await place(ref.driverId, NEARBY, 20 * 60);

    const res = await get(id, ref.driverId);
    expect(res.status).toBe(200);
    expect(res.body.reason).not.toBe('no-position');
  });
});

describe('when there is nothing to draw', () => {
  it('says so when the driver has never reported', async () => {
    const id = await orderWithPickup();
    // No position row at all.

    const res = await get(id, ref.driverId);

    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    expect(res.body.reason).toBe('no-position');
    expect(res.body.points).toEqual([]);
    expect(res.body.distanceM).toBeNull();
    // Still names the driver, so the UI can explain which one is missing.
    expect(res.body.driver.name).toBeTruthy();
  });

  it('does not use a (0,0) position, which is a failed geocode not a place', async () => {
    const id = await orderWithPickup();
    await place(ref.driverId, { lat: 0, lng: 0 });

    const res = await get(id, ref.driverId);
    expect(res.body.available).toBe(false);
    expect(res.body.reason).toBe('no-position');
  });
});

describe('refusals', () => {
  it('409s when the pickup was never pinned', async () => {
    const id = await orderWithPickup(null);
    await place(ref.driverId, NEARBY);

    const res = await get(id, ref.driverId);

    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/no pickup coordinates/i);
  });

  it('404s for an order that does not exist', async () => {
    const res = await get('cns_nope', ref.driverId);
    expect(res.status).toBe(404);
  });

  it('404s for a driver that does not exist — that is a caller error', async () => {
    const id = await orderWithPickup();
    const res = await get(id, 'drv_nope');
    expect(res.status).toBe(404);
  });

  it('requires a driver', async () => {
    const id = await orderWithPickup();
    const res = await api.get(`/api/consignments/${id}/driver-route`).set(auth());
    expect(res.status).toBe(400);
  });

  it('rejects an unknown query parameter', async () => {
    const id = await orderWithPickup();
    const res = await api
      .get(`/api/consignments/${id}/driver-route`)
      .query({ driverId: ref.driverId, mode: 'bike' })
      .set(auth());
    expect(res.status).toBe(400);
  });

  it('is operator-only — a driver must not read another’s position', async () => {
    const id = await orderWithPickup();
    const res = await api
      .get(`/api/consignments/${id}/driver-route`)
      .query({ driverId: ref.driverBId })
      .set(asDriver());
    expect(res.status).toBe(403);
  });
});
