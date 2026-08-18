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
 * GET /api/consignments/:id/nearest-drivers
 *
 * Written to pass whether or not a local OSRM is running: the service falls back
 * to straight-line distance when it cannot reach one, so these assert the parts
 * that hold either way — who is offered, who is excluded, the ordering, and that
 * `meta.source` states honestly which of the two produced the numbers. A suite
 * that demanded a routing binary be installed would just get skipped.
 */

let ref: Reference;
let token: string;
let driverToken: string;

// Pickup: Sundar Industrial Estate, south-west Lahore.
const PICKUP = { lat: 31.4183, lng: 74.1725 };
// Near the pickup, and right across the city.
const NEAR = { lat: 31.4256, lng: 74.1889 };
const FAR = { lat: 31.5698, lng: 74.4123 };

beforeAll(async () => {
  ref = await seedReference();
  token = await getToken();
  driverToken = await getDriverToken(ref.driverId);
});

const auth = () => authHeader(token);
const asDriver = () => authHeader(driverToken);

/** An order with pinned pickup coordinates — the ranking needs a target. */
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

/**
 * Put a driver on the map.
 *
 * Writes `driver_positions`, not `driver_locations`: "where is this driver now" is
 * answered from the one-row-per-driver position table, while history only records
 * significant movement. Writing history here would place nobody on the map.
 */
function ping(driverId: string, at: { lat: number; lng: number }, minutesAgo = 0) {
  const recordedAt = new Date(Date.now() - minutesAgo * 60_000);
  return prisma.driverPosition.upsert({
    where: { driverId },
    create: { driverId, lat: at.lat, lng: at.lng, recordedAt },
    update: { lat: at.lat, lng: at.lng, recordedAt },
  });
}

const get = (id: string, query: Record<string, string> = {}) =>
  api.get(`/api/consignments/${id}/nearest-drivers`).query(query).set(auth());

beforeEach(async () => {
  await cleanConsignments();
  // seedReference clocks both test drivers on; individual tests clock them off.
  await prisma.driver.updateMany({
    where: { id: { in: [ref.driverId, ref.driverBId] } },
    data: { active: true, onShift: true },
  });
});

describe('who gets offered', () => {
  it('ranks a driver who is on shift and reporting', async () => {
    const id = await orderWithPickup();
    await ping(ref.driverId, NEAR);

    const res = await get(id);

    expect(res.status).toBe(200);
    const mine = res.body.data.find((d: { driverId: string }) => d.driverId === ref.driverId);
    expect(mine.ranked).toBe(true);
    expect(mine.distanceM).toBeGreaterThan(0);
    // Whichever engine answered, it must say which.
    expect(['osrm', 'straight-line']).toContain(res.body.meta.source);
  });

  it('leaves out a driver who is off shift, because assignment would refuse them', async () => {
    const id = await orderWithPickup();
    await ping(ref.driverBId, NEAR);
    await prisma.driver.update({ where: { id: ref.driverBId }, data: { onShift: false } });

    const res = await get(id);

    const ids = res.body.data.map((d: { driverId: string }) => d.driverId);
    expect(ids).not.toContain(ref.driverBId);
  });

  it('leaves out a driver who has been deactivated', async () => {
    const id = await orderWithPickup();
    await ping(ref.driverBId, NEAR);
    await prisma.driver.update({ where: { id: ref.driverBId }, data: { active: false } });

    const res = await get(id);

    const ids = res.body.data.map((d: { driverId: string }) => d.driverId);
    expect(ids).not.toContain(ref.driverBId);
  });

  it('still lists an on-shift driver who has never reported, marked unrankable', async () => {
    const id = await orderWithPickup();
    await ping(ref.driverId, NEAR);
    // driverB is clocked on with no ping at all.

    const res = await get(id);

    const theirs = res.body.data.find((d: { driverId: string }) => d.driverId === ref.driverBId);
    // Genuinely assignable — just not measurable. Hiding them would make the list
    // shorter than the roster with no explanation.
    expect(theirs).toBeTruthy();
    expect(theirs.ranked).toBe(false);
    expect(theirs.durationS).toBeNull();
    // Not an exact count: this suite shares a database with the seeded roster,
    // whose on-shift drivers have no pings either and are correctly counted here.
    expect(res.body.meta.unlocatedCount).toBeGreaterThanOrEqual(1);
  });

  it('drops the unrankable ones when asked', async () => {
    const id = await orderWithPickup();
    await ping(ref.driverId, NEAR);

    const res = await get(id, { includeUnlocated: 'false' });

    const ids = res.body.data.map((d: { driverId: string }) => d.driverId);
    expect(ids).not.toContain(ref.driverBId);
    expect(ids).toContain(ref.driverId);
  });

  it('treats a stale position as no position', async () => {
    const id = await orderWithPickup();
    await ping(ref.driverId, NEAR, 30); // half an hour old

    const res = await get(id, { withinMinutes: '3' });

    const mine = res.body.data.find((d: { driverId: string }) => d.driverId === ref.driverId);
    expect(mine.ranked).toBe(false);
    expect(res.body.meta.rankedCount).toBe(0);
  });

  it('accepts a wider window for the same stale position', async () => {
    const id = await orderWithPickup();
    await ping(ref.driverId, NEAR, 30);

    const res = await get(id, { withinMinutes: '60' });

    const mine = res.body.data.find((d: { driverId: string }) => d.driverId === ref.driverId);
    expect(mine.ranked).toBe(true);
    expect(mine.staleSeconds).toBeGreaterThan(60);
  });
});

describe('the ordering', () => {
  it('puts the nearer driver first', async () => {
    const id = await orderWithPickup();
    await ping(ref.driverId, FAR);
    await ping(ref.driverBId, NEAR);

    const res = await get(id);

    // B is beside the pickup, A is across the city — by road or by crow, B wins.
    expect(res.body.data[0].driverId).toBe(ref.driverBId);
    expect(res.body.data[1].driverId).toBe(ref.driverId);
  });

  it('sorts rankable drivers ahead of unrankable ones', async () => {
    const id = await orderWithPickup();
    await ping(ref.driverId, FAR); // far away, but measurable

    const res = await get(id);

    // Even the furthest measurable driver beats one we cannot place at all.
    expect(res.body.data[0].driverId).toBe(ref.driverId);
    expect(res.body.data[0].ranked).toBe(true);
    expect(res.body.data.at(-1).ranked).toBe(false);
  });

  it('reports the pickup it measured against', async () => {
    const id = await orderWithPickup();
    const res = await get(id);

    expect(res.body.meta.pickup.lat).toBeCloseTo(PICKUP.lat, 4);
    expect(res.body.meta.pickup.lng).toBeCloseTo(PICKUP.lng, 4);
    expect(res.body.meta.pickup.city).toBe('Lahore');
    // Never claim live traffic — these come from static OSM speed profiles.
    expect(res.body.meta.trafficAware).toBe(false);
  });
});

describe('refusals', () => {
  it('409s when the pickup was never pinned', async () => {
    // The default factory payload has no coordinates, which is the real-world
    // case of an address typed but never placed on the map.
    const id = await orderWithPickup(null);

    const res = await get(id);

    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/no pickup coordinates/i);
  });

  it('404s for an order that does not exist', async () => {
    const res = await get('cns_nope');
    expect(res.status).toBe(404);
  });

  it('is operator-only — a driver must not read the roster’s live positions', async () => {
    const id = await orderWithPickup();
    const res = await api.get(`/api/consignments/${id}/nearest-drivers`).set(asDriver());
    expect(res.status).toBe(403);
  });

  it('rejects an unknown query parameter', async () => {
    const id = await orderWithPickup();
    const res = await get(id, { nearest: '5' });
    expect(res.status).toBe(400);
  });

  it('rejects a nonsense window', async () => {
    const id = await orderWithPickup();
    const res = await get(id, { withinMinutes: '0' });
    expect(res.status).toBe(400);
  });
});
