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

/*
 * The dispatch map's read surface.
 *
 * The assertion that matters most is that the three tab counts partition the
 * total. If they ever stop adding up, a dispatcher is looking at a badge that
 * disagrees with the list under it.
 */

let ref: Reference;
let token: string;
let driverToken: string;

beforeAll(async () => {
  ref = await seedReference();
  token = await getToken();
  driverToken = await getDriverToken(ref.driverId);
});

beforeEach(async () => {
  await cleanConsignments();
});

const auth = () => authHeader(token);
const asDriver = () => authHeader(driverToken);

/** The factory leaves coordinates unset, so pin tests must supply them. */
function withCoords(over: Record<string, unknown> = {}) {
  return buildConsignment(ref.clientId, {
    sender: {
      name: 'Daraz Fulfilment Centre',
      line1: 'Warehouse 4',
      area: 'Raiwind Road',
      city: 'Lahore',
      postcode: '54000',
      lat: 31.52,
      lng: 74.35,
    },
    receiver: {
      name: 'Sana Yousaf',
      line1: 'House 214, Street 8',
      area: 'DHA Phase 5',
      city: 'Lahore',
      postcode: '54792',
      lat: 31.47,
      lng: 74.41,
    },
    ...over,
  });
}

async function create(payload: Record<string, unknown>): Promise<string> {
  const res = await api.post('/api/consignments').set(auth()).send(payload);
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function assignTo(id: string, driverId: string) {
  const res = await api.post(`/api/consignments/${id}/assign`).set(auth()).send({ driverId });
  expect(res.status).toBe(200);
}

/** DELIVERED is only reachable through a proof upload, so set it directly. */
async function forceDelivered(id: string, driverId: string) {
  await prisma.consignment.update({
    where: { id },
    data: { driverId, status: 'DELIVERED', deliveredAt: new Date() },
  });
}

const pins = (query = '') => api.get(`/api/map/pins${query}`).set(auth());

/* ------------------------------------------------------------------ */

describe('GET /api/map/pins', () => {
  it('plots a task at its receiver, and still reports the sender', async () => {
    await create(withCoords());

    const res = await pins();
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);

    const pin = res.body.data[0];
    expect(pin.lat).toBeCloseTo(31.47);
    expect(pin.lng).toBeCloseTo(74.41);
    // Both pairs ship, so "which end does the pin show" stays a client choice.
    expect(pin.senderLat).toBeCloseTo(31.52);
    expect(pin.receiverLat).toBeCloseTo(31.47);
  });

  it('carries the click-widget fields so a pin opens without another request', async () => {
    await create(withCoords());

    const pin = (await pins()).body.data[0];
    expect(pin.receiverName).toBe('Sana Yousaf');
    expect(pin.receiverLine1).toBe('House 214, Street 8');
    expect(pin.receiverCity).toBe('Lahore');
    expect(pin.taskType).toBe('DELIVERY');
    expect(pin.status).toBe('UNASSIGNED');
    // The factory carries two item lines, qty 1 and 2.
    expect(pin.totalQty).toBe(3);
  });

  it('never exposes the note or the item lines', async () => {
    await create(withCoords());

    const body = JSON.stringify((await pins()).body);
    expect(body).not.toContain('generalNote');
    expect(body).not.toContain('Handle with care');
  });

  it('counts partition the total', async () => {
    await create(withCoords());
    const assigned = await create(withCoords({ clientReference: 'MAP-A' }));
    await assignTo(assigned, ref.driverId);
    const done = await create(withCoords({ clientReference: 'MAP-B' }));
    await forceDelivered(done, ref.driverBId);

    const { counts, total } = (await pins()).body.meta;

    expect(counts.unassigned + counts.assigned + counts.completed).toBe(total);
    expect(counts.unassigned).toBe(1);
    expect(counts.assigned).toBe(1);
    expect(counts.completed).toBe(1);
  });

  it('keeps a task in Assigned once it moves past ASSIGNED', async () => {
    const id = await create(withCoords());
    await assignTo(id, ref.driverId);
    await api
      .patch(`/api/consignments/${id}/status`)
      .set(auth())
      .send({ status: 'EN_ROUTE_TO_PICKUP' });

    const { counts } = (await pins()).body.meta;
    expect(counts.assigned).toBe(1);
    expect(counts.unassigned).toBe(0);
  });

  it('narrows the rows by tab but leaves the badges alone', async () => {
    await create(withCoords());
    const assigned = await create(withCoords({ clientReference: 'MAP-C' }));
    await assignTo(assigned, ref.driverId);

    const res = await pins('?tab=unassigned');

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].status).toBe('UNASSIGNED');
    // Badges are facets: switching tab must not change the numbers.
    expect(res.body.meta.counts.assigned).toBe(1);
    expect(res.body.meta.total).toBe(2);
  });

  it('returns an unplottable task rather than hiding it', async () => {
    // No coordinates at all — the factory's default.
    await create(buildConsignment(ref.clientId));

    const res = await pins();
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].lat).toBeNull();
    expect(res.body.meta.unmappable).toBe(1);
  });

  it('treats null island as unplottable', async () => {
    // (0, 0) is a valid Float pair and a real place in the Gulf of Guinea, so it
    // is what an import bug looks like — not a location in Pakistan.
    await create(
      withCoords({
        receiver: {
          name: 'Broken import',
          line1: 'Nowhere',
          city: 'Lahore',
          lat: 0,
          lng: 0,
        },
      }),
    );

    const res = await pins();
    expect(res.body.data[0].lat).toBeNull();
    expect(res.body.meta.unmappable).toBe(1);
  });

  it('filters by driver, and tab ANDs with it instead of overwriting', async () => {
    const mine = await create(withCoords());
    await assignTo(mine, ref.driverId);
    const theirs = await create(withCoords({ clientReference: 'MAP-D' }));
    await assignTo(theirs, ref.driverBId);

    const one = await pins(`?driverIds=${ref.driverId}`);
    expect(one.body.data).toHaveLength(1);
    expect(one.body.data[0].id).toBe(mine);

    // A driver's unassigned tasks are definitionally none — the honest answer,
    // not "ignore one of the two filters".
    const contradiction = await pins(`?driverIds=${ref.driverId}&tab=unassigned`);
    expect(contradiction.body.data).toHaveLength(0);
  });

  it('reports a per-driver tally', async () => {
    const id = await create(withCoords());
    await assignTo(id, ref.driverId);

    const { byDriver } = (await pins()).body.meta;
    expect(byDriver[ref.driverId]).toBe(1);
  });

  it('exposes the driver colour on the pin', async () => {
    const id = await create(withCoords());
    await assignTo(id, ref.driverId);

    const pin = (await pins()).body.data[0];
    expect(pin.driver.id).toBe(ref.driverId);
    expect(pin.driver.colorIndex).toBeGreaterThanOrEqual(0);
    expect(pin.driver.colorIndex).toBeLessThan(8);
  });

  it('rejects an unknown query parameter', async () => {
    expect((await pins('?bbox=1,2,3,4')).status).toBe(400);
  });

  it('refuses a driver token', async () => {
    expect((await api.get('/api/map/pins').set(asDriver())).status).toBe(403);
  });
});

describe('GET /api/map/drivers', () => {
  it('lists a driver with nothing to do', async () => {
    const res = await api.get('/api/map/drivers').set(auth());

    expect(res.status).toBe(200);
    const idle = res.body.data.find((d: { id: string }) => d.id === ref.driverId);
    expect(idle).toBeTruthy();
    expect(idle.assignedCount).toBe(0);
  });

  it('agrees with the map about how much a driver is carrying', async () => {
    const id = await create(withCoords());
    await assignTo(id, ref.driverId);

    const [roster, map] = await Promise.all([
      api.get('/api/map/drivers').set(auth()),
      pins(`?driverIds=${ref.driverId}`),
    ]);

    const row = roster.body.data.find((d: { id: string }) => d.id === ref.driverId);
    expect(row.assignedCount).toBe(map.body.data.length);
  });

  it('gives every driver a colour slot', async () => {
    const res = await api.get('/api/map/drivers').set(auth());

    for (const d of res.body.data) {
      expect(d.colorIndex).toBeGreaterThanOrEqual(0);
      expect(d.colorIndex).toBeLessThan(8);
    }
  });

  it('refuses a driver token', async () => {
    expect((await api.get('/api/map/drivers').set(asDriver())).status).toBe(403);
  });
});

describe('the consignments list gained the same tab filter', () => {
  it('filters by tab using the shared status mapping', async () => {
    await create(withCoords());
    const assigned = await create(withCoords({ clientReference: 'MAP-E' }));
    await assignTo(assigned, ref.driverId);

    const res = await api.get('/api/consignments?tab=assigned').set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe(assigned);
  });
});
