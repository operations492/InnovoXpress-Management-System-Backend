import { describe, it, expect, afterAll, beforeAll, beforeEach } from 'vitest';
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

let ref: Reference;
let token: string;
let driverToken: string;
let driverBToken: string;

beforeAll(async () => {
  ref = await seedReference();
  token = await getToken();
  driverToken = await getDriverToken(ref.driverId);
  driverBToken = await getDriverToken(ref.driverBId);
});

beforeEach(async () => {
  await cleanConsignments();
});

const auth = () => authHeader(token);
const asDriver = () => authHeader(driverToken);
const asDriverB = () => authHeader(driverBToken);

/** Create an order and assign it, so the driver has something to act on. */
async function assignedOrder(driverId: string) {
  const created = await api
    .post('/api/consignments')
    .set(auth())
    .send(buildConsignment(ref.clientId));
  await api
    .post(`/api/consignments/${created.body.id}/assign`)
    .set(auth())
    .send({ driverId });
  return created.body.id as string;
}

// There is no 'driver sign-in' block any more: the password-free
// /drivers/roster + /drivers/session pair was deleted in the Supabase Auth
// migration, so there is no endpoint left to test. Supabase Auth issues every
// driver token now, and getDriverToken() in ./helpers/api.js exercises that
// real sign-in on every run of this file.

describe('a driver token cannot reach the console', () => {
  // Password-free sign-in means anyone with the URL holds a driver token, so
  // these four are the difference between a demo and a data leak.
  it.each([
    ['consignment list', '/api/consignments'],
    ['reference data', '/api/reference'],
    ['driver roster with phone numbers', '/api/drivers'],
    ['live map', '/api/drivers/locations/latest'],
  ])('blocks %s', async (_label, path) => {
    const res = await api.get(path).set(asDriver());
    expect(res.status).toBe(403);
  });
});

describe('the shift switch', () => {
  const shift = (t: Record<string, string>, onShift: boolean) =>
    api.post('/api/drivers/me/shift').set(t).send({ onShift });

  const stored = (id: string) =>
    prisma.driver.findUniqueOrThrow({
      where: { id },
      select: { onShift: true, shiftStartedAt: true, shiftEndedAt: true },
    });

  /** The login that speaks for this driver — deactivation happens on the user. */
  const loginIdOf = (driverId: string) =>
    prisma.user
      .findFirstOrThrow({ where: { driverId }, select: { id: true } })
      .then((u) => u.id);

  beforeEach(async () => {
    // Start every case from a driver who has never clocked on, so a leftover
    // timestamp from the previous test cannot make an assertion pass. The
    // reactivation matters too: a failed deactivation case would otherwise leave
    // the driver locked out and fail every test after it for the wrong reason.
    await prisma.driver.update({
      where: { id: ref.driverId },
      data: { active: true, onShift: false, shiftStartedAt: null, shiftEndedAt: null },
    });
    await prisma.user.updateMany({
      where: { driverId: ref.driverId },
      data: { active: true },
    });
  });

  it('opens a shift with a start and no end', async () => {
    const res = await shift(asDriver(), true);

    expect(res.status).toBe(200);
    expect(res.body.onShift).toBe(true);
    expect(res.body.shiftStartedAt).toBeTruthy();
    expect(res.body.shiftEndedAt).toBeNull();
  });

  it('stamps the close time when the driver clocks off', async () => {
    await shift(asDriver(), true);
    const res = await shift(asDriver(), false);

    expect(res.body.onShift).toBe(false);
    expect(res.body.shiftEndedAt).toBeTruthy();
    // Within the minute, which also proves the column is written as UTC rather
    // than local time — a timezone slip would land hours out.
    expect(Math.abs(new Date(res.body.shiftEndedAt).getTime() - Date.now())).toBeLessThan(60_000);
  });

  it('keeps the start time, so a closed shift still has a length', async () => {
    const on = await shift(asDriver(), true);
    const off = await shift(asDriver(), false);

    // The old code nulled shiftStartedAt on clock-off, which left a close time
    // that could not answer "how long did they work?".
    expect(off.body.shiftStartedAt).toBe(on.body.shiftStartedAt);
    expect(new Date(off.body.shiftEndedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(off.body.shiftStartedAt).getTime(),
    );
  });

  it('reopens cleanly, clearing the previous close time', async () => {
    await shift(asDriver(), true);
    await shift(asDriver(), false);
    const res = await shift(asDriver(), true);

    // Null end is the marker for "a shift is open right now"; leaving the old one
    // in place would make every off-shift query see a driver as still finished.
    expect(res.body.shiftEndedAt).toBeNull();
    expect(res.body.onShift).toBe(true);
  });

  it('is idempotent — a retry from a flaky phone moves neither timestamp', async () => {
    const on = await shift(asDriver(), true);
    const onAgain = await shift(asDriver(), true);
    expect(onAgain.body.shiftStartedAt).toBe(on.body.shiftStartedAt);

    const off = await shift(asDriver(), false);
    const offAgain = await shift(asDriver(), false);
    expect(offAgain.body.shiftEndedAt).toBe(off.body.shiftEndedAt);
  });

  it('closes an open shift when an admin deactivates the driver', async () => {
    await shift(asDriver(), true);

    const res = await api
      .patch(`/api/users/${await loginIdOf(ref.driverId)}`)
      .set(auth())
      .send({ active: false });
    expect(res.status).toBe(200);

    // Someone who has left cannot be left looking available with an open shift.
    const row = await stored(ref.driverId);
    expect(row.onShift).toBe(false);
    expect(row.shiftEndedAt).toBeTruthy();
  });

  it('does not invent a close time for a driver who was already off', async () => {
    await shift(asDriver(), true);
    const off = await shift(asDriver(), false);

    await api
      .patch(`/api/users/${await loginIdOf(ref.driverId)}`)
      .set(auth())
      .send({ active: false });

    // Deactivating weeks later must not overwrite the real end of their last
    // shift with the moment the paperwork happened.
    const row = await stored(ref.driverId);
    expect(row.shiftEndedAt!.toISOString()).toBe(new Date(off.body.shiftEndedAt).toISOString());
  });

  it('reports the close time on the console roster', async () => {
    await shift(asDriver(), true);
    await shift(asDriver(), false);

    const res = await api.get('/api/drivers').set(auth());
    const me = res.body.data.find((d: { id: string }) => d.id === ref.driverId);
    expect(me.shiftEndedAt).toBeTruthy();
  });

  it('is the driver’s own switch — an operator cannot clock someone on', async () => {
    const res = await shift(auth(), true);
    expect(res.status).toBe(403);
  });

  afterAll(async () => {
    // Hand the driver back clocked ON. Assignment refuses an off-shift driver, so
    // leaving them off here would 409 every later block in this file that needs an
    // assigned order.
    await prisma.driver.update({
      where: { id: ref.driverId },
      data: { active: true, onShift: true },
    });
    await prisma.user.updateMany({ where: { driverId: ref.driverId }, data: { active: true } });
  });
});

describe('GET /api/drivers/me/consignments', () => {
  it('returns only my own jobs', async () => {
    const mine = await assignedOrder(ref.driverId);
    await assignedOrder(ref.driverBId);

    const res = await api.get('/api/drivers/me/consignments').set(asDriver());

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe(mine);
  });

  it('is scoped by the token, so another driver sees a different list', async () => {
    await assignedOrder(ref.driverId);
    const theirs = await assignedOrder(ref.driverBId);

    const res = await api.get('/api/drivers/me/consignments').set(asDriverB());
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe(theirs);
  });

  it('hides delivered jobs by default and includes them on request', async () => {
    const id = await assignedOrder(ref.driverId);
    await prisma.consignment.update({ where: { id }, data: { status: 'DELIVERED' } });

    const hidden = await api.get('/api/drivers/me/consignments').set(asDriver());
    const shown = await api
      .get('/api/drivers/me/consignments')
      .query({ includeDelivered: 'true' })
      .set(asDriver());

    expect(hidden.body.data).toHaveLength(0);
    expect(shown.body.data).toHaveLength(1);
  });

  it('tells the app what to do next at each step', async () => {
    const id = await assignedOrder(ref.driverId);

    const nextAction = async () => {
      const res = await api.get('/api/drivers/me/consignments').set(asDriver());
      return res.body.data[0].nextAction;
    };

    expect(await nextAction()).toBe('START_PICKUP');

    await api
      .patch(`/api/consignments/${id}/status`)
      .set(asDriver())
      .send({ status: 'EN_ROUTE_TO_PICKUP' });
    expect(await nextAction()).toBe('ARRIVE_AT_PICKUP');

    await api
      .patch(`/api/consignments/${id}/status`)
      .set(asDriver())
      .send({ status: 'AT_PICKUP' });
    // The camera step, not a status button — proof is the only way forward.
    expect(await nextAction()).toBe('CAPTURE_PICKUP_PROOF');
  });

  it('requires a driver token, not an operator one', async () => {
    const res = await api.get('/api/drivers/me/consignments').set(auth());
    expect(res.status).toBe(403);
  });
});

describe('ownership', () => {
  it('lets a driver read their own order', async () => {
    const id = await assignedOrder(ref.driverId);
    const res = await api.get(`/api/consignments/${id}`).set(asDriver());
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(id);
  });

  it('blocks reading another driver’s order', async () => {
    const theirs = await assignedOrder(ref.driverBId);
    const res = await api.get(`/api/consignments/${theirs}`).set(asDriver());
    expect(res.status).toBe(403);
  });

  it('lets a driver move their own order along', async () => {
    const id = await assignedOrder(ref.driverId);
    const res = await api
      .patch(`/api/consignments/${id}/status`)
      .set(asDriver())
      .send({ status: 'EN_ROUTE_TO_PICKUP' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('EN_ROUTE_TO_PICKUP');
  });

  it('blocks changing another driver’s order', async () => {
    const theirs = await assignedOrder(ref.driverBId);
    const res = await api
      .patch(`/api/consignments/${theirs}/status`)
      .set(asDriver())
      .send({ status: 'EN_ROUTE_TO_PICKUP' });

    expect(res.status).toBe(403);
  });

  it('does not reveal whether an unowned order exists', async () => {
    const theirs = await assignedOrder(ref.driverBId);
    const real = await api.get(`/api/consignments/${theirs}`).set(asDriver());
    const fake = await api.get('/api/consignments/cl_does_not_exist').set(asDriver());

    // Both 403: a 404 here would let a driver probe which ids are real.
    expect(real.status).toBe(403);
    expect(fake.status).toBe(403);
  });

  it('still lets an operator act on any order', async () => {
    const id = await assignedOrder(ref.driverBId);
    const res = await api.get(`/api/consignments/${id}`).set(auth());
    expect(res.status).toBe(200);
  });

  it('never lets a driver skip proof and force a delivered status', async () => {
    const id = await assignedOrder(ref.driverId);
    await api.patch(`/api/consignments/${id}/status`).set(asDriver()).send({ status: 'EN_ROUTE_TO_PICKUP' });
    await api.patch(`/api/consignments/${id}/status`).set(asDriver()).send({ status: 'AT_PICKUP' });

    const pickedUp = await api
      .patch(`/api/consignments/${id}/status`)
      .set(asDriver())
      .send({ status: 'PICKED_UP' });
    const delivered = await api
      .patch(`/api/consignments/${id}/status`)
      .set(asDriver())
      .send({ status: 'DELIVERED' });

    expect(pickedUp.status).toBe(400);
    expect(delivered.status).toBe(400);

    const after = await api.get(`/api/consignments/${id}`).set(auth());
    expect(after.body.status).toBe('AT_PICKUP');
  });

  it('does not let a driver assign or unassign anyone', async () => {
    const id = await assignedOrder(ref.driverId);
    const assign = await api
      .post(`/api/consignments/${id}/assign`)
      .set(asDriver())
      .send({ driverId: ref.driverBId });
    const unassign = await api.delete(`/api/consignments/${id}/assign`).set(asDriver());

    expect(assign.status).toBe(403);
    expect(unassign.status).toBe(403);
  });
});
