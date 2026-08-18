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
 * Bulk assign, and planned routes.
 *
 * A route is a plan: it records a visiting order and touches nothing else. These
 * assert that separation as much as the happy path — an order's status, driver and
 * lifecycle must be exactly what they would have been without any of this.
 *
 * Written to survive a missing OSRM: without an engine the create endpoint answers
 * 503, so every route test checks for that first and skips rather than failing. A
 * suite that demanded a routing binary would simply be skipped on another machine,
 * which is worse than one that says so.
 */

let ref: Reference;
let token: string;
let driverToken: string;

/** A depot in south-west Lahore, and drops spread across the city. */
const START = { lat: 31.4183, lng: 74.1725, label: 'Sundar Depot' };
const DROPS = [
  { lat: 31.5204, lng: 74.3587 },
  { lat: 31.4697, lng: 74.3294 },
  { lat: 31.5497, lng: 74.3436 },
  { lat: 31.48, lng: 74.26 },
];

beforeAll(async () => {
  ref = await seedReference();
  token = await getToken();
  driverToken = await getDriverToken(ref.driverId);
});

const auth = () => authHeader(token);
const asDriver = () => authHeader(driverToken);

/** An order with a pinned DELIVERY address — the only coordinate a route uses. */
async function makeOrder(drop: { lat: number; lng: number } | null) {
  const payload = buildConsignment(ref.clientId);
  const res = await api
    .post('/api/consignments')
    .set(auth())
    .send({
      ...payload,
      receiver: { ...payload.receiver, ...(drop ? { lat: drop.lat, lng: drop.lng } : {}) },
    });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

const makeOrders = (n = DROPS.length) =>
  Promise.all(DROPS.slice(0, n).map((d) => makeOrder(d)));

const bulkAssign = (consignmentIds: string[], driverId = ref.driverId) =>
  api.post('/api/consignments/assign-bulk').set(auth()).send({ consignmentIds, driverId });

const createRoute = (consignmentIds: string[], extra: Record<string, unknown> = {}) =>
  api
    .post('/api/routes')
    .set(auth())
    .send({ driverId: ref.driverId, consignmentIds, start: START, ...extra });

/** True when there is no local OSRM, so a route cannot be planned at all. */
const noEngine = (res: { status: number }) => res.status === 503;

beforeEach(async () => {
  await cleanConsignments();
  await prisma.route.deleteMany({});
  await prisma.driver.updateMany({
    where: { id: { in: [ref.driverId, ref.driverBId] } },
    data: { active: true, onShift: true },
  });
});

/* ------------------------------------------------------------------ */

describe('bulk assign', () => {
  it('assigns every selected order to one driver', async () => {
    const ids = await makeOrders();

    const res = await bulkAssign(ids);

    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ requested: 4, assigned: 4, failed: 0 });

    const rows = await prisma.consignment.findMany({
      where: { id: { in: ids } },
      select: { driverId: true, status: true },
    });
    expect(rows.every((r) => r.driverId === ref.driverId)).toBe(true);
    expect(rows.every((r) => r.status === 'ASSIGNED')).toBe(true);
  });

  it('keeps the good ones when one order fails', async () => {
    const ids = await makeOrders();
    // Push one order past the point where its driver may be changed.
    await prisma.consignment.update({
      where: { id: ids[1] },
      data: { driverId: ref.driverBId, status: 'AT_PICKUP' },
    });

    const res = await bulkAssign(ids);

    // The whole point of the endpoint: 3 of 4 is a useful outcome, not a rollback.
    expect(res.body.counts).toEqual({ requested: 4, assigned: 3, failed: 1 });
    expect(res.body.failed).toHaveLength(1);
    expect(res.body.failed[0].id).toBe(ids[1]);
    // Named by order number, because the operator picked these off a map.
    expect(res.body.failed[0].orderNo).toBeTruthy();
    expect(res.body.failed[0].message).toBeTruthy();
  });

  it('refuses an off-shift driver outright', async () => {
    const ids = await makeOrders(2);
    await prisma.driver.update({ where: { id: ref.driverId }, data: { onShift: false } });

    const res = await bulkAssign(ids);

    // Every order fails for the same reason — the driver, not the orders.
    expect(res.body.counts.assigned).toBe(0);
    expect(res.body.failed).toHaveLength(2);
    expect(res.body.failed[0].message).toMatch(/off shift/i);
  });

  it('counts a duplicated id once', async () => {
    const ids = await makeOrders(2);
    const res = await bulkAssign([ids[0], ids[0], ids[1]]);
    expect(res.body.counts.requested).toBe(2);
  });

  it('rejects an empty selection', async () => {
    const res = await bulkAssign([]);
    expect(res.status).toBe(400);
  });

  it('is operator-only', async () => {
    const ids = await makeOrders(1);
    const res = await api
      .post('/api/consignments/assign-bulk')
      .set(asDriver())
      .send({ consignmentIds: ids, driverId: ref.driverId });
    expect(res.status).toBe(403);
  });
});

/* ------------------------------------------------------------------ */

describe('creating a route', () => {
  it('plans a run and returns it in visiting order', async () => {
    const ids = await makeOrders();
    await bulkAssign(ids);

    const res = await createRoute(ids);
    if (noEngine(res)) return;

    expect(res.status).toBe(201);
    expect(res.body.stops).toHaveLength(4);
    // Sequence numbers are 1..n with no gaps — that is what the UI renders.
    expect(res.body.stops.map((s: { seq: number }) => s.seq)).toEqual([1, 2, 3, 4]);
    expect(new Set(res.body.stops.map((s: { consignmentId: string }) => s.consignmentId))).toEqual(
      new Set(ids),
    );
    expect(res.body.sequenceSource).toBe('OPTIMISED');
    expect(res.body.points.length).toBeGreaterThan(1);
    expect(res.body.distanceM).toBeGreaterThan(0);
    expect(res.body.trafficAware).toBe(false);
  });

  it('changes nothing about the orders themselves', async () => {
    const ids = await makeOrders();
    await bulkAssign(ids);

    const before = await prisma.consignment.findMany({
      where: { id: { in: ids } },
      select: { id: true, status: true, driverId: true },
      orderBy: { id: 'asc' },
    });

    const res = await createRoute(ids);
    if (noEngine(res)) return;

    // A route is a PLAN. It gates no status and demands no proof; if planning ever
    // starts moving orders, this is the test that says so.
    const after = await prisma.consignment.findMany({
      where: { id: { in: ids } },
      select: { id: true, status: true, driverId: true },
      orderBy: { id: 'asc' },
    });
    expect(after).toEqual(before);
  });

  it('draws the line through the start, so the depot is where the run begins', async () => {
    const ids = await makeOrders();
    await bulkAssign(ids);

    const res = await createRoute(ids);
    if (noEngine(res)) return;

    const [firstLat, firstLng] = res.body.points[0];
    expect(Math.abs(firstLat - START.lat)).toBeLessThan(0.03);
    expect(Math.abs(firstLng - START.lng)).toBeLessThan(0.03);
    // And every point is in Lahore, which catches a lat/lng swap.
    for (const [lat, lng] of res.body.points as [number, number][]) {
      expect(lat).toBeGreaterThan(31);
      expect(lat).toBeLessThan(32);
      expect(lng).toBeGreaterThan(74);
      expect(lng).toBeLessThan(75);
    }
  });

  it('honours an end location when one is given', async () => {
    const ids = await makeOrders();
    await bulkAssign(ids);

    const end = { lat: 31.5497, lng: 74.3436, label: 'Yard' };
    const res = await createRoute(ids, { end });
    if (noEngine(res)) return;

    expect(res.body.end).toMatchObject({ label: 'Yard' });
    const [lastLat, lastLng] = res.body.points[res.body.points.length - 1];
    expect(Math.abs(lastLat - end.lat)).toBeLessThan(0.03);
    expect(Math.abs(lastLng - end.lng)).toBeLessThan(0.03);
  });

  it('supersedes the driver’s previous plan rather than stacking two', async () => {
    const ids = await makeOrders();
    await bulkAssign(ids);

    const first = await createRoute(ids);
    if (noEngine(first)) return;
    const second = await createRoute(ids);
    expect(second.status).toBe(201);

    // The partial unique index allows exactly one ACTIVE route per driver.
    const active = await prisma.route.count({
      where: { driverId: ref.driverId, status: 'ACTIVE' },
    });
    expect(active).toBe(1);
    const superseded = await prisma.route.findUnique({ where: { id: first.body.id } });
    expect(superseded!.status).toBe('SUPERSEDED');
  });

  it('is idempotent for a double-tapped Save', async () => {
    const ids = await makeOrders();
    await bulkAssign(ids);

    const a = await createRoute(ids, { clientKey: 'tap-once' });
    if (noEngine(a)) return;
    const b = await createRoute(ids, { clientKey: 'tap-once' });

    expect(b.body.id).toBe(a.body.id);
    expect(await prisma.route.count({ where: { driverId: ref.driverId } })).toBe(1);
  });

  it('refuses orders with no delivery pin, and names them', async () => {
    const pinned = await makeOrders(2);
    const unpinned = await makeOrder(null);
    await bulkAssign([...pinned, unpinned]);

    const res = await createRoute([...pinned, unpinned]);
    if (noEngine(res)) return;

    expect(res.status).toBe(409);
    // With fifty selected, "some cannot be routed" is useless — it must say which.
    expect(res.body.error.message).toMatch(/no delivery pin/i);
    expect(res.body.error.message).toMatch(/[A-Z]{3}-\d{8}-\d{4}/);
  });

  it('refuses orders belonging to someone else', async () => {
    const ids = await makeOrders();
    await bulkAssign(ids, ref.driverBId);

    const res = await createRoute(ids);
    if (noEngine(res)) return;

    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/not assigned to/i);
  });

  it('refuses an off-shift driver', async () => {
    const ids = await makeOrders();
    await bulkAssign(ids);
    await prisma.driver.update({ where: { id: ref.driverId }, data: { onShift: false } });

    const res = await createRoute(ids);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/off shift/i);
  });

  it('rejects a start location that is not a real place', async () => {
    const ids = await makeOrders();
    await bulkAssign(ids);
    // (0,0) is the Gulf of Guinea — what a failed geocode leaves behind.
    const res = await createRoute(ids, { start: { lat: 0, lng: 0 } });
    expect(res.status).toBe(400);
  });

  it('needs at least two stops to be a route', async () => {
    const ids = await makeOrders(1);
    await bulkAssign(ids);
    const res = await createRoute(ids);
    expect(res.status).toBe(400);
  });

  it('is operator-only', async () => {
    const res = await api
      .post('/api/routes')
      .set(asDriver())
      .send({ driverId: ref.driverId, consignmentIds: ['a', 'b'], start: START });
    expect(res.status).toBe(403);
  });
});

/* ------------------------------------------------------------------ */

describe('reading a route', () => {
  it('is what the DRIVERS tab loads', async () => {
    const ids = await makeOrders();
    await bulkAssign(ids);
    const created = await createRoute(ids);
    if (noEngine(created)) return;

    const res = await api.get(`/api/routes/driver/${ref.driverId}`).set(auth());

    expect(res.status).toBe(200);
    expect(res.body.route.id).toBe(created.body.id);
    expect(res.body.route.stops).toHaveLength(4);
    expect(res.body.route.points.length).toBeGreaterThan(1);
  });

  it('answers null for a driver with no plan, not 404', async () => {
    const res = await api.get(`/api/routes/driver/${ref.driverBId}`).set(auth());
    // The tab asks this constantly; "no plan" is an answer, not an error.
    expect(res.status).toBe(200);
    expect(res.body.route).toBeNull();
  });

  it('flags a stop whose order was taken by another driver', async () => {
    const ids = await makeOrders();
    await bulkAssign(ids);
    const created = await createRoute(ids);
    if (noEngine(created)) return;

    await prisma.consignment.update({
      where: { id: ids[0] },
      data: { driverId: ref.driverBId },
    });

    const res = await api.get(`/api/routes/driver/${ref.driverId}`).set(auth());
    const stop = res.body.route.stops.find(
      (s: { consignmentId: string }) => s.consignmentId === ids[0],
    );

    // Flagged for a human — the route must not silently rewrite itself.
    expect(stop.issues).toContain('reassigned');
    expect(res.body.route.needsReview).toBe(true);
  });

  it('flags a delivery address that moved after planning', async () => {
    const ids = await makeOrders();
    await bulkAssign(ids);
    const created = await createRoute(ids);
    if (noEngine(created)) return;

    // Across town — far beyond the drift tolerance.
    await prisma.consignment.update({
      where: { id: ids[0] },
      data: { receiverLat: 31.62, receiverLng: 74.44 },
    });

    const res = await api.get(`/api/routes/driver/${ref.driverId}`).set(auth());
    const stop = res.body.route.stops.find(
      (s: { consignmentId: string }) => s.consignmentId === ids[0],
    );

    // Only the snapshot makes this detectable: the old coordinate exists nowhere
    // else once the consignment is updated.
    expect(stop.issues).toContain('address-moved');
  });

  it('flags a delivered stop without disturbing the rest', async () => {
    const ids = await makeOrders();
    await bulkAssign(ids);
    const created = await createRoute(ids);
    if (noEngine(created)) return;

    await prisma.consignment.update({
      where: { id: ids[0] },
      data: { status: 'DELIVERED' },
    });

    const res = await api.get(`/api/routes/driver/${ref.driverId}`).set(auth());
    expect(res.body.route.stops).toHaveLength(4);
    const stop = res.body.route.stops.find(
      (s: { consignmentId: string }) => s.consignmentId === ids[0],
    );
    expect(stop.issues).toContain('delivered');
  });

  it('is operator-only', async () => {
    const res = await api.get(`/api/routes/driver/${ref.driverId}`).set(asDriver());
    expect(res.status).toBe(403);
  });
});

/* ------------------------------------------------------------------ */

describe('reordering', () => {
  async function planned() {
    const ids = await makeOrders();
    await bulkAssign(ids);
    const created = await createRoute(ids);
    return created;
  }

  it('applies the operator’s order exactly', async () => {
    const created = await planned();
    if (noEngine(created)) return;

    const current = created.body.stops.map((s: { consignmentId: string }) => s.consignmentId);
    const reversed = [...current].reverse();

    const res = await api
      .patch(`/api/routes/${created.body.id}/sequence`)
      .set(auth())
      .send({ consignmentIds: reversed, version: created.body.version });

    expect(res.status).toBe(200);
    expect(res.body.stops.map((s: { consignmentId: string }) => s.consignmentId)).toEqual(reversed);
    expect(res.body.stops.map((s: { seq: number }) => s.seq)).toEqual([1, 2, 3, 4]);
    // A hand-made order must never be silently re-optimised later.
    expect(res.body.sequenceSource).toBe('MANUAL');
  });

  it('redraws the line to match the new order', async () => {
    const created = await planned();
    if (noEngine(created)) return;

    const reversed = [...created.body.stops]
      .map((s: { consignmentId: string }) => s.consignmentId)
      .reverse();

    const res = await api
      .patch(`/api/routes/${created.body.id}/sequence`)
      .set(auth())
      .send({ consignmentIds: reversed, version: created.body.version });

    // Nothing was cached, so the geometry follows the saved order automatically.
    expect(res.body.points.length).toBeGreaterThan(1);
    expect(res.body.distanceM).toBeGreaterThan(0);
  });

  it('refuses a list that adds or drops a stop', async () => {
    const created = await planned();
    if (noEngine(created)) return;

    const ids = created.body.stops.map((s: { consignmentId: string }) => s.consignmentId);

    const res = await api
      .patch(`/api/routes/${created.body.id}/sequence`)
      .set(auth())
      .send({ consignmentIds: ids.slice(0, 3), version: created.body.version });

    // Dragging a row must not become a way to change what the driver carries.
    expect(res.status).toBe(400);
  });

  it('refuses a stale version, so two dispatchers cannot both win', async () => {
    const created = await planned();
    if (noEngine(created)) return;

    const ids = created.body.stops.map((s: { consignmentId: string }) => s.consignmentId);
    const first = await api
      .patch(`/api/routes/${created.body.id}/sequence`)
      .set(auth())
      .send({ consignmentIds: [...ids].reverse(), version: created.body.version });
    expect(first.status).toBe(200);

    const second = await api
      .patch(`/api/routes/${created.body.id}/sequence`)
      .set(auth())
      .send({ consignmentIds: ids, version: created.body.version });

    expect(second.status).toBe(409);
    expect(second.body.error.message).toMatch(/changed while you were editing/i);
  });
});

/* ------------------------------------------------------------------ */

describe('re-optimise', () => {
  it('proposes an order and changes nothing', async () => {
    const ids = await makeOrders();
    await bulkAssign(ids);
    const created = await createRoute(ids);
    if (noEngine(created)) return;

    const before = created.body.stops.map((s: { consignmentId: string }) => s.consignmentId);

    const res = await api.post(`/api/routes/${created.body.id}/optimise`).set(auth());

    expect(res.status).toBe(200);
    expect(res.body.consignmentIds).toHaveLength(4);
    expect(res.body.saves).toHaveProperty('durationS');

    // A preview. Accepting it is a separate, deliberate reorder.
    const after = await api.get(`/api/routes/driver/${ref.driverId}`).set(auth());
    expect(after.body.route.stops.map((s: { consignmentId: string }) => s.consignmentId)).toEqual(
      before,
    );
  });

  it('can be accepted by feeding it straight back to the reorder endpoint', async () => {
    const ids = await makeOrders();
    await bulkAssign(ids);
    const created = await createRoute(ids);
    if (noEngine(created)) return;

    const preview = await api.post(`/api/routes/${created.body.id}/optimise`).set(auth());

    const applied = await api
      .patch(`/api/routes/${created.body.id}/sequence`)
      .set(auth())
      .send({ consignmentIds: preview.body.consignmentIds, version: preview.body.version });

    expect(applied.status).toBe(200);
    expect(applied.body.stops.map((s: { consignmentId: string }) => s.consignmentId)).toEqual(
      preview.body.consignmentIds,
    );
  });
});

/* ------------------------------------------------------------------ */

describe('clearing', () => {
  it('retires the plan and leaves the assignments alone', async () => {
    const ids = await makeOrders();
    await bulkAssign(ids);
    const created = await createRoute(ids);
    if (noEngine(created)) return;

    const res = await api.delete(`/api/routes/driver/${ref.driverId}`).set(auth());
    expect(res.status).toBe(200);

    const after = await api.get(`/api/routes/driver/${ref.driverId}`).set(auth());
    expect(after.body.route).toBeNull();

    // The work survives the plan.
    const rows = await prisma.consignment.findMany({
      where: { id: { in: ids } },
      select: { driverId: true },
    });
    expect(rows.every((r) => r.driverId === ref.driverId)).toBe(true);
  });

  it('404s when there is nothing to clear', async () => {
    const res = await api.delete(`/api/routes/driver/${ref.driverBId}`).set(auth());
    expect(res.status).toBe(404);
  });
});
