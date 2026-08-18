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

beforeAll(async () => {
  ref = await seedReference();
  token = await getToken();
});

beforeEach(async () => {
  await cleanConsignments();
});

const auth = () => authHeader(token);

describe('POST /api/consignments', () => {
  it('logs an order against its client and returns a client-prefixed order number', async () => {
    const res = await api
      .post('/api/consignments')
      .set(auth())
      .send(buildConsignment(ref.clientId, { clientReference: 'PO-1001' }));

    expect(res.status).toBe(201);
    expect(res.body.orderNo).toMatch(new RegExp(`^${ref.clientCode}-\\d{8}-\\d{4}$`));
    expect(res.body.client.id).toBe(ref.clientId);
    expect(res.body.status).toBe('UNASSIGNED');
    expect(res.body.statusLabel).toBe('Unassigned');
    expect(res.body.driver).toBeNull();
    expect(res.body.clientReference).toBe('PO-1001');
  });

  it('stores structured sender and receiver addresses', async () => {
    const res = await api
      .post('/api/consignments')
      .set(auth())
      .send(buildConsignment(ref.clientId));

    expect(res.status).toBe(201);
    expect(res.body.sender.city).toBe('Lahore');
    expect(res.body.sender.area).toBe('Raiwind Road');
    expect(res.body.receiver.city).toBe('Lahore');
    expect(res.body.receiver.area).toBe('DHA Phase 5');
    expect(res.body.receiver.postcode).toBe('54792');
  });

  it('stores items and totals their quantity and weight', async () => {
    const res = await api
      .post('/api/consignments')
      .set(auth())
      .send(buildConsignment(ref.clientId));

    expect(res.status).toBe(201);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.totals.itemCount).toBe(2);
    expect(res.body.totals.totalQty).toBe(3);
    expect(res.body.totals.totalWeightKg).toBeCloseTo(0.6, 3);
    expect(res.body.items[0].packageType).toBe('BOX');
  });

  it('opens the audit trail with a single logged event', async () => {
    const res = await api
      .post('/api/consignments')
      .set(auth())
      .send(buildConsignment(ref.clientId));

    expect(res.body.timeline).toHaveLength(1);
    expect(res.body.timeline[0].fromStatus).toBeNull();
    expect(res.body.timeline[0].toStatus).toBe('UNASSIGNED');
  });

  it('rejects an unknown client', async () => {
    const res = await api
      .post('/api/consignments')
      .set(auth())
      .send(buildConsignment('cl_does_not_exist'));

    expect(res.status).toBe(400);
  });

  it('rejects an order with no items', async () => {
    const res = await api
      .post('/api/consignments')
      .set(auth())
      .send(buildConsignment(ref.clientId, { items: [] }));

    expect(res.status).toBe(400);
  });

  it('rejects a client-supplied status instead of silently ignoring it', async () => {
    const res = await api
      .post('/api/consignments')
      .set(auth())
      .send(buildConsignment(ref.clientId, { status: 'DELIVERED' }));

    expect(res.status).toBe(400);
  });

  it('rejects a client-supplied order number', async () => {
    const res = await api
      .post('/api/consignments')
      .set(auth())
      .send(buildConsignment(ref.clientId, { orderNo: 'HAND-ROLLED-1' }));

    expect(res.status).toBe(400);
  });

  it('refuses a duplicate client reference within the same client', async () => {
    const payload = buildConsignment(ref.clientId, { clientReference: 'PO-DUP' });
    const first = await api.post('/api/consignments').set(auth()).send(payload);
    expect(first.status).toBe(201);

    const second = await api.post('/api/consignments').set(auth()).send(payload);
    expect(second.status).toBe(409);
  });

  it('allows the same client reference for a different client', async () => {
    const a = await api
      .post('/api/consignments')
      .set(auth())
      .send(buildConsignment(ref.clientId, { clientReference: 'PO-SHARED' }));
    const b = await api
      .post('/api/consignments')
      .set(auth())
      .send(buildConsignment(ref.otherClientId, { clientReference: 'PO-SHARED' }));

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.orderNo).toMatch(new RegExp(`^${ref.otherClientCode}-`));
  });

  it('requires a token', async () => {
    const res = await api.post('/api/consignments').send(buildConsignment(ref.clientId));
    expect(res.status).toBe(401);
  });
});

describe('GET /api/consignments', () => {
  beforeEach(async () => {
    await api.post('/api/consignments').set(auth()).send(buildConsignment(ref.clientId));
    await api
      .post('/api/consignments')
      .set(auth())
      .send(
        buildConsignment(ref.otherClientId, {
          receiver: {
            name: 'Imran Qureshi',
            phone: '+92 333 2298871',
            line1: 'Flat 703, Ocean Tower',
            area: 'Clifton',
            city: 'Karachi',
          },
        }),
      );
  });

  it('scopes the list to one client', async () => {
    const res = await api
      .get('/api/consignments')
      .query({ clientId: ref.clientId })
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].client.id).toBe(ref.clientId);
  });

  it('returns page metadata', async () => {
    const res = await api.get('/api/consignments').query({ pageSize: 1 }).set(auth());

    expect(res.body.meta).toEqual({ total: 2, page: 1, pageSize: 1, totalPages: 2 });
    expect(res.body.data).toHaveLength(1);
  });

  it('filters by status', async () => {
    const hit = await api.get('/api/consignments').query({ status: 'UNASSIGNED' }).set(auth());
    const miss = await api.get('/api/consignments').query({ status: 'DELIVERED' }).set(auth());

    expect(hit.body.data).toHaveLength(2);
    expect(miss.body.data).toHaveLength(0);
  });

  it('free-text searches across receiver city', async () => {
    const res = await api.get('/api/consignments').query({ q: 'Karachi' }).set(auth());

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].receiverCity).toBe('Karachi');
  });

  it('free-text searches by order number', async () => {
    const list = await api.get('/api/consignments').set(auth());
    const target = list.body.data[0].orderNo as string;

    const res = await api.get('/api/consignments').query({ q: target }).set(auth());
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].orderNo).toBe(target);
  });

  it('summarises totals per row', async () => {
    const res = await api
      .get('/api/consignments')
      .query({ clientId: ref.clientId })
      .set(auth());

    expect(res.body.data[0].totalQty).toBe(3);
    expect(res.body.data[0].itemCount).toBe(2);
  });

  it('rejects an unknown query parameter', async () => {
    const res = await api.get('/api/consignments').query({ bogus: 'x' }).set(auth());
    expect(res.status).toBe(400);
  });
});

describe('GET /api/consignments/:id', () => {
  it('returns the full record', async () => {
    const created = await api
      .post('/api/consignments')
      .set(auth())
      .send(buildConsignment(ref.clientId));

    const res = await api.get(`/api/consignments/${created.body.id}`).set(auth());

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(created.body.id);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.proofs).toEqual([]);
    expect(res.body.timeline).toHaveLength(1);
  });

  it('404s for an unknown id', async () => {
    const res = await api.get('/api/consignments/cl_nope').set(auth());
    expect(res.status).toBe(404);
  });
});

describe('PUT /api/consignments/:id', () => {
  it('updates fields while the order is still editable', async () => {
    const created = await api
      .post('/api/consignments')
      .set(auth())
      .send(buildConsignment(ref.clientId));

    const res = await api
      .put(`/api/consignments/${created.body.id}`)
      .set(auth())
      .send({ priority: 'HIGH', generalNote: 'Escalated by client' });

    expect(res.status).toBe(200);
    expect(res.body.priority).toBe('HIGH');
    expect(res.body.generalNote).toBe('Escalated by client');
  });

  it('keeps item ids stable for supplied items and drops omitted ones', async () => {
    const created = await api
      .post('/api/consignments')
      .set(auth())
      .send(buildConsignment(ref.clientId));

    const keep = created.body.items[0];

    const res = await api
      .put(`/api/consignments/${created.body.id}`)
      .set(auth())
      .send({
        items: [
          { id: keep.id, description: keep.description, qty: 5, weightKg: 1.5 },
          { description: 'Newly added carton', qty: 1, weightKg: 2 },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);

    const kept = res.body.items.find((i: { id: string }) => i.id === keep.id);
    expect(kept).toBeDefined();
    expect(kept.qty).toBe(5);
    expect(res.body.items.some((i: { description: string }) => i.description === 'USB-C cable 2m')).toBe(
      false,
    );
  });

  it('rejects a status change through the update endpoint', async () => {
    const created = await api
      .post('/api/consignments')
      .set(auth())
      .send(buildConsignment(ref.clientId));

    const res = await api
      .put(`/api/consignments/${created.body.id}`)
      .set(auth())
      .send({ status: 'DELIVERED' });

    expect(res.status).toBe(400);
  });

  it('refuses to edit an order that has already moved', async () => {
    const created = await api
      .post('/api/consignments')
      .set(auth())
      .send(buildConsignment(ref.clientId));

    // Simulate Feature 2/4 having advanced the order.
    await prisma.consignment.update({
      where: { id: created.body.id },
      data: { status: 'EN_ROUTE_TO_PICKUP', driverId: ref.driverId },
    });

    const res = await api
      .put(`/api/consignments/${created.body.id}`)
      .set(auth())
      .send({ priority: 'LOW' });

    expect(res.status).toBe(409);
  });

  it('404s for an unknown id', async () => {
    const res = await api
      .put('/api/consignments/cl_nope')
      .set(auth())
      .send({ priority: 'LOW' });
    expect(res.status).toBe(404);
  });
});
