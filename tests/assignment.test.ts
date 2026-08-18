import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api,
  authHeader,
  cleanConsignments,
  getToken,
  prisma,
  seedReference,
  type Reference,
} from './helpers/api.js';
import { buildConsignment } from './helpers/factory.js';

let ref: Reference;
let token: string;
let secondDriverId: string;

beforeAll(async () => {
  ref = await seedReference();
  token = await getToken();

  const second = await prisma.driver.upsert({
    where: { code: 'test-driver-2' },
    update: { name: 'Second Driver', active: true },
    create: { name: 'Second Driver', code: 'test-driver-2', active: true },
  });
  secondDriverId = second.id;
});

beforeEach(async () => {
  await cleanConsignments();
});

const auth = () => authHeader(token);

async function newOrder() {
  const res = await api
    .post('/api/consignments')
    .set(auth())
    .send(buildConsignment(ref.clientId));
  return res.body.id as string;
}

describe('POST /api/consignments/:id/assign', () => {
  it('attaches a driver and moves the order to assigned', async () => {
    const id = await newOrder();

    const res = await api
      .post(`/api/consignments/${id}/assign`)
      .set(auth())
      .send({ driverId: ref.driverId });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ASSIGNED');
    expect(res.body.statusLabel).toBe('Assigned');
    expect(res.body.driver.id).toBe(ref.driverId);
    expect(res.body.assignedAt).not.toBeNull();
  });

  it('records the assignment in the timeline', async () => {
    const id = await newOrder();
    const res = await api
      .post(`/api/consignments/${id}/assign`)
      .set(auth())
      .send({ driverId: ref.driverId });

    // Newest first: the assignment, then the original logging event.
    expect(res.body.timeline).toHaveLength(2);
    expect(res.body.timeline[0].fromStatus).toBe('UNASSIGNED');
    expect(res.body.timeline[0].toStatus).toBe('ASSIGNED');
    expect(res.body.timeline[0].driver.id).toBe(ref.driverId);
    expect(res.body.timeline[0].note).toContain('Assigned to');
  });

  it('swaps the driver while the run has not started', async () => {
    const id = await newOrder();
    await api.post(`/api/consignments/${id}/assign`).set(auth()).send({ driverId: ref.driverId });

    const res = await api
      .post(`/api/consignments/${id}/assign`)
      .set(auth())
      .send({ driverId: secondDriverId });

    expect(res.status).toBe(200);
    expect(res.body.driver.id).toBe(secondDriverId);
    expect(res.body.status).toBe('ASSIGNED');
    expect(res.body.timeline[0].note).toContain('Reassigned from');
  });

  it('refuses to reassign the same driver', async () => {
    const id = await newOrder();
    await api.post(`/api/consignments/${id}/assign`).set(auth()).send({ driverId: ref.driverId });

    const res = await api
      .post(`/api/consignments/${id}/assign`)
      .set(auth())
      .send({ driverId: ref.driverId });

    expect(res.status).toBe(409);
  });

  it('refuses once the driver is already on the road', async () => {
    const id = await newOrder();
    await api.post(`/api/consignments/${id}/assign`).set(auth()).send({ driverId: ref.driverId });
    await prisma.consignment.update({
      where: { id },
      data: { status: 'EN_ROUTE_TO_PICKUP' },
    });

    const res = await api
      .post(`/api/consignments/${id}/assign`)
      .set(auth())
      .send({ driverId: secondDriverId });

    expect(res.status).toBe(409);
  });

  it('rejects an unknown driver', async () => {
    const id = await newOrder();
    const res = await api
      .post(`/api/consignments/${id}/assign`)
      .set(auth())
      .send({ driverId: 'drv_nope' });

    expect(res.status).toBe(400);
  });

  it('rejects an inactive driver', async () => {
    const inactive = await prisma.driver.upsert({
      where: { code: 'test-driver-off' },
      update: { active: false },
      create: { name: 'Retired Driver', code: 'test-driver-off', active: false },
    });
    const id = await newOrder();

    const res = await api
      .post(`/api/consignments/${id}/assign`)
      .set(auth())
      .send({ driverId: inactive.id });

    expect(res.status).toBe(400);
  });

  it('404s for an unknown consignment', async () => {
    const res = await api
      .post('/api/consignments/cl_nope/assign')
      .set(auth())
      .send({ driverId: ref.driverId });

    expect(res.status).toBe(404);
  });

  it('requires a token', async () => {
    const id = await newOrder();
    const res = await api
      .post(`/api/consignments/${id}/assign`)
      .send({ driverId: ref.driverId });

    expect(res.status).toBe(401);
  });
});

describe('DELETE /api/consignments/:id/assign', () => {
  it('returns the order to the unassigned queue', async () => {
    const id = await newOrder();
    await api.post(`/api/consignments/${id}/assign`).set(auth()).send({ driverId: ref.driverId });

    const res = await api.delete(`/api/consignments/${id}/assign`).set(auth());

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('UNASSIGNED');
    expect(res.body.driver).toBeNull();
    expect(res.body.assignedAt).toBeNull();
    expect(res.body.timeline[0].toStatus).toBe('UNASSIGNED');
  });

  it('refuses when no driver is attached', async () => {
    const id = await newOrder();
    const res = await api.delete(`/api/consignments/${id}/assign`).set(auth());
    expect(res.status).toBe(409);
  });

  it('refuses once the run has started', async () => {
    const id = await newOrder();
    await api.post(`/api/consignments/${id}/assign`).set(auth()).send({ driverId: ref.driverId });
    await prisma.consignment.update({
      where: { id },
      data: { status: 'AT_PICKUP' },
    });

    const res = await api.delete(`/api/consignments/${id}/assign`).set(auth());
    expect(res.status).toBe(409);
  });
});

describe('assignment keeps the database invariant', () => {
  it('never leaves a driver attached to an unassigned order', async () => {
    const id = await newOrder();
    await api.post(`/api/consignments/${id}/assign`).set(auth()).send({ driverId: ref.driverId });
    await api.delete(`/api/consignments/${id}/assign`).set(auth());

    // The CHECK constraint makes "assigned but driverless" unrepresentable, so
    // a mismatch here would have failed at the database, not just in a test.
    const rows = await prisma.consignment.findMany({
      where: {
        OR: [
          { status: 'UNASSIGNED', driverId: { not: null } },
          { status: { not: 'UNASSIGNED' }, driverId: null },
        ],
      },
      select: { id: true },
    });

    expect(rows).toEqual([]);
  });
});

describe('GET /api/drivers', () => {
  it('lists active drivers with their current load', async () => {
    const id = await newOrder();
    await api.post(`/api/consignments/${id}/assign`).set(auth()).send({ driverId: ref.driverId });

    const res = await api.get('/api/drivers').set(auth());

    expect(res.status).toBe(200);
    const driver = res.body.data.find((d: { id: string }) => d.id === ref.driverId);
    expect(driver.activeLoad).toBe(1);

    const idle = res.body.data.find((d: { id: string }) => d.id === secondDriverId);
    expect(idle.activeLoad).toBe(0);
  });

  it('stops counting an order once it is delivered', async () => {
    const id = await newOrder();
    await api.post(`/api/consignments/${id}/assign`).set(auth()).send({ driverId: ref.driverId });
    await prisma.consignment.update({ where: { id }, data: { status: 'DELIVERED' } });

    const res = await api.get('/api/drivers').set(auth());
    const driver = res.body.data.find((d: { id: string }) => d.id === ref.driverId);

    expect(driver.activeLoad).toBe(0);
  });

  it('hides inactive drivers unless asked', async () => {
    await prisma.driver.upsert({
      where: { code: 'test-driver-off' },
      update: { active: false },
      create: { name: 'Retired Driver', code: 'test-driver-off', active: false },
    });

    const hidden = await api.get('/api/drivers').set(auth());
    const shown = await api.get('/api/drivers').query({ includeInactive: 'true' }).set(auth());

    const codes = (r: { body: { data: Array<{ code: string }> } }) =>
      r.body.data.map((d) => d.code);

    expect(codes(hidden)).not.toContain('test-driver-off');
    expect(codes(shown)).toContain('test-driver-off');
  });

  it('searches by name', async () => {
    const res = await api.get('/api/drivers').query({ q: 'Second' }).set(auth());
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe(secondDriverId);
  });

  it('requires a token', async () => {
    const res = await api.get('/api/drivers');
    expect(res.status).toBe(401);
  });
});
