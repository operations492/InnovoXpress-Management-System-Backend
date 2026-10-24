import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api,
  authHeader,
  cleanConsignments,
  ensureConsoleUser,
  getDriverToken,
  getToken,
  prisma,
  seedReference,
  TEST_DOMAIN,
  type Reference,
} from './helpers/api.js';
import { buildConsignment } from './helpers/factory.js';

let ref: Reference;
let admin: string;
let operator: string;
let driver: string;

beforeAll(async () => {
  ref = await seedReference();
  admin = await getToken();
  operator = (
    await ensureConsoleUser({ email: `ops-cl@${TEST_DOMAIN}`, name: 'Ops CL', role: 'operator' })
  ).token;
  driver = await getDriverToken(ref.driverId);
});

beforeEach(async () => {
  // cleanConsignments() clears the order counters too, so the fixture clients
  // are left without children and anything this suite created can simply go.
  await cleanConsignments();
  await prisma.client.deleteMany({
    where: { id: { notIn: [ref.clientId, ref.otherClientId] } },
  });
});

const asAdmin = () => authHeader(admin);
const asOperator = () => authHeader(operator);
const asDriver = () => authHeader(driver);

const ADDRESS = {
  contactName: 'Warehouse Desk',
  phone: '+1 905 555 0142',
  email: 'dispatch@northpoint.example.ca',
  line1: '6750 Century Avenue',
  city: 'Mississauga',
  province: 'ON',
  postcode: 'L5N 2V8',
  lat: 43.589,
  lng: -79.7,
  instructions: 'Loading dock 4.',
};

async function createClient(body: Record<string, unknown>) {
  return api.post('/api/clients').set(asAdmin()).send(body);
}

describe('clients', () => {
  it('operators read the list, drivers cannot, only admins write', async () => {
    expect((await api.get('/api/clients').set(asOperator())).status).toBe(200);
    expect((await api.get('/api/clients').set(asDriver())).status).toBe(403);

    const denied = await api
      .post('/api/clients')
      .set(asOperator())
      .send({ name: 'Northpoint', code: 'NPT' });
    expect(denied.status).toBe(403);

    const created = await createClient({ name: 'Northpoint', code: 'NPT' });
    expect(created.status).toBe(201);
    expect(created.body.active).toBe(true);
    expect(created.body.usageCount).toBe(0);
    // No address was given, so there is nothing to prefill with.
    expect(created.body.address).toBeNull();
  });

  it('normalises the code and the postcode, and returns the address as one object', async () => {
    const created = await createClient({
      name: 'Northpoint',
      code: 'npt',
      address: { ...ADDRESS, postcode: 'l5n2v8' },
    });

    expect(created.status).toBe(201);
    expect(created.body.code).toBe('NPT');
    expect(created.body.address.postcode).toBe('L5N 2V8');
    expect(created.body.address.line1).toBe('6750 Century Avenue');
    expect(created.body.address.lat).toBeCloseTo(43.589);
  });

  it('refuses an address that could not be routed, and unknown keys', async () => {
    const { lat, ...noPin } = ADDRESS;
    const missingPin = await createClient({ name: 'Northpoint', code: 'NPT', address: noPin });
    expect(missingPin.status).toBe(400);

    const missingStreet = await createClient({
      name: 'Northpoint',
      code: 'NPT',
      address: { ...ADDRESS, line1: '' },
    });
    expect(missingStreet.status).toBe(400);

    const badProvince = await createClient({
      name: 'Northpoint',
      code: 'NPT',
      address: { ...ADDRESS, province: 'Ontario' },
    });
    expect(badProvince.status).toBe(400);

    const unknownKey = await createClient({ name: 'Northpoint', code: 'NPT', notAColumn: true });
    expect(unknownKey.status).toBe(400);
  });

  it('keeps names and codes unique case-insensitively', async () => {
    expect((await createClient({ name: 'Northpoint', code: 'NPT' })).status).toBe(201);

    const dupName = await createClient({ name: 'northpoint', code: 'ZZZ' });
    expect(dupName.status).toBe(409);

    const dupCode = await createClient({ name: 'Something Else', code: 'npt' });
    expect(dupCode.status).toBe(409);
  });

  it('replaces the address wholesale and clears it with null', async () => {
    const created = await createClient({ name: 'Northpoint', code: 'NPT', address: ADDRESS });

    const moved = await api
      .patch(`/api/clients/${created.body.id}`)
      .set(asAdmin())
      .send({ address: { ...ADDRESS, line1: '5875 Explorer Drive', instructions: null } });
    expect(moved.status).toBe(200);
    expect(moved.body.address.line1).toBe('5875 Explorer Drive');
    expect(moved.body.address.instructions).toBeNull();

    const cleared = await api
      .patch(`/api/clients/${created.body.id}`)
      .set(asAdmin())
      .send({ address: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.address).toBeNull();

    // Omitting the address leaves it alone rather than wiping it.
    const renamed = await api
      .patch(`/api/clients/${created.body.id}`)
      .set(asAdmin())
      .send({ name: 'Northpoint Logistics' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe('Northpoint Logistics');
  });

  it('freezes the code once the client has orders, but still allows a rename', async () => {
    const created = await createClient({ name: 'Northpoint', code: 'NPT' });
    const id = created.body.id as string;

    const order = await api.post('/api/consignments').set(asAdmin()).send(buildConsignment(id));
    expect(order.status).toBe(201);
    expect(order.body.orderNo.startsWith('NPT-')).toBe(true);

    const recode = await api.patch(`/api/clients/${id}`).set(asAdmin()).send({ code: 'NPX' });
    expect(recode.status).toBe(409);

    const rename = await api
      .patch(`/api/clients/${id}`)
      .set(asAdmin())
      .send({ name: 'Northpoint Logistics' });
    expect(rename.status).toBe(200);
    expect(rename.body.code).toBe('NPT');
    expect(rename.body.usageCount).toBe(1);
  });

  it('deletes only an unused client, and hides a retired one from the dropdown', async () => {
    const created = await createClient({ name: 'Northpoint', code: 'NPT' });
    const id = created.body.id as string;

    const order = await api.post('/api/consignments').set(asAdmin()).send(buildConsignment(id));
    expect(order.status).toBe(201);

    const blocked = await api.delete(`/api/clients/${id}`).set(asAdmin());
    expect(blocked.status).toBe(409);

    const retired = await api.patch(`/api/clients/${id}`).set(asAdmin()).send({ active: false });
    expect(retired.status).toBe(200);

    const dropdown = await api.get('/api/clients').set(asOperator());
    expect(dropdown.body.some((c: { id: string }) => c.id === id)).toBe(false);

    const adminView = await api.get('/api/clients?includeInactive=true').set(asAdmin());
    expect(adminView.body.some((c: { id: string }) => c.id === id)).toBe(true);

    await cleanConsignments();
    expect((await api.delete(`/api/clients/${id}`).set(asAdmin())).status).toBe(204);
    expect((await api.get(`/api/clients/${id}`).set(asAdmin())).status).toBe(404);
  });

  it('carries the address on /api/reference so the form prefills in one request', async () => {
    await createClient({ name: 'Northpoint', code: 'NPT', address: ADDRESS });

    const reference = await api.get('/api/reference').set(asOperator());
    expect(reference.status).toBe(200);

    const northpoint = reference.body.clients.find((c: { code: string }) => c.code === 'NPT');
    expect(northpoint.address.line1).toBe('6750 Century Avenue');
    expect(northpoint.address.city).toBe('Mississauga');
    expect(northpoint.address.lng).toBeCloseTo(-79.7);
  });
});
