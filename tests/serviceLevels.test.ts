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
    await ensureConsoleUser({ email: `ops-sl@${TEST_DOMAIN}`, name: 'Ops SL', role: 'operator' })
  ).token;
  driver = await getDriverToken(ref.driverId);
});

beforeEach(async () => {
  await cleanConsignments();
  // Only the fixture level survives between tests.
  await prisma.serviceLevel.deleteMany({ where: { id: { not: ref.serviceLevelId } } });
});

const asAdmin = () => authHeader(admin);
const asOperator = () => authHeader(operator);
const asDriver = () => authHeader(driver);

describe('service levels — the list', () => {
  it('operators can read it; drivers cannot', async () => {
    const ok = await api.get('/api/service-levels').set(asOperator());
    expect(ok.status).toBe(200);
    expect(ok.body.some((l: { id: string }) => l.id === ref.serviceLevelId)).toBe(true);

    const no = await api.get('/api/service-levels').set(asDriver());
    expect(no.status).toBe(403);
  });

  it('is offered to the consignment form through /api/reference, active only', async () => {
    await prisma.serviceLevel.create({ data: { name: 'Retired Van', active: false } });

    const res = await api.get('/api/reference').set(asOperator());
    expect(res.status).toBe(200);
    const names = res.body.serviceLevels.map((l: { name: string }) => l.name);
    expect(names).toContain('Test Expedite');
    expect(names).not.toContain('Retired Van');
  });

  it('lists retired levels only when asked', async () => {
    await prisma.serviceLevel.create({ data: { name: 'Retired Van', active: false } });

    const dflt = await api.get('/api/service-levels').set(asAdmin());
    expect(dflt.body.map((l: { name: string }) => l.name)).not.toContain('Retired Van');

    const all = await api.get('/api/service-levels?includeInactive=true').set(asAdmin());
    expect(all.body.map((l: { name: string }) => l.name)).toContain('Retired Van');
  });
});

describe('service levels — admin changes', () => {
  it('only an admin may create, and names are unique case-insensitively', async () => {
    const denied = await api.post('/api/service-levels').set(asOperator()).send({ name: 'Reefer Van' });
    expect(denied.status).toBe(403);

    const created = await api.post('/api/service-levels').set(asAdmin()).send({ name: 'Reefer Van' });
    expect(created.status).toBe(201);
    expect(created.body.active).toBe(true);
    expect(created.body.usageCount).toBe(0);

    const dup = await api.post('/api/service-levels').set(asAdmin()).send({ name: 'reefer van' });
    expect(dup.status).toBe(409);
  });

  it('renames, reorders and retires in one call', async () => {
    const created = await api.post('/api/service-levels').set(asAdmin()).send({ name: 'Mini Van' });

    const res = await api
      .patch(`/api/service-levels/${created.body.id}`)
      .set(asAdmin())
      .send({ name: 'Mini Van - City', sortOrder: 3, active: false });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Mini Van - City');
    expect(res.body.sortOrder).toBe(3);
    expect(res.body.active).toBe(false);
  });

  it('deletes an unused level, refuses one that orders reference', async () => {
    const unused = await api.post('/api/service-levels').set(asAdmin()).send({ name: 'Unused' });
    const gone = await api.delete(`/api/service-levels/${unused.body.id}`).set(asAdmin());
    expect(gone.status).toBe(204);

    await api
      .post('/api/consignments')
      .set(asAdmin())
      .send(buildConsignment(ref.clientId, { serviceLevelId: ref.serviceLevelId }));

    const inUse = await api.delete(`/api/service-levels/${ref.serviceLevelId}`).set(asAdmin());
    expect(inUse.status).toBe(409);
    expect(inUse.body.error.message).toContain('deactivate');
  });
});

describe('service level on a consignment', () => {
  it('is stored on create and returned by name', async () => {
    const res = await api
      .post('/api/consignments')
      .set(asAdmin())
      .send(buildConsignment(ref.clientId, { serviceLevelId: ref.serviceLevelId }));

    expect(res.status).toBe(201);
    expect(res.body.serviceLevel).toEqual({ id: ref.serviceLevelId, name: 'Test Expedite' });

    const list = await api.get('/api/consignments').set(asAdmin());
    expect(list.body.data[0].serviceLevel.name).toBe('Test Expedite');
  });

  it('is optional, and null when omitted', async () => {
    const res = await api.post('/api/consignments').set(asAdmin()).send(buildConsignment(ref.clientId));
    expect(res.status).toBe(201);
    expect(res.body.serviceLevel).toBeNull();
  });

  it('refuses an unknown or retired level with a 400', async () => {
    const unknown = await api
      .post('/api/consignments')
      .set(asAdmin())
      .send(buildConsignment(ref.clientId, { serviceLevelId: 'nope' }));
    expect(unknown.status).toBe(400);

    const retired = await prisma.serviceLevel.create({ data: { name: 'Retired Van', active: false } });
    const res = await api
      .post('/api/consignments')
      .set(asAdmin())
      .send(buildConsignment(ref.clientId, { serviceLevelId: retired.id }));
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('no longer offered');
  });

  it('can be changed or cleared on update', async () => {
    const created = await api
      .post('/api/consignments')
      .set(asAdmin())
      .send(buildConsignment(ref.clientId, { serviceLevelId: ref.serviceLevelId }));

    const other = await api.post('/api/service-levels').set(asAdmin()).send({ name: 'Other' });
    const changed = await api
      .put(`/api/consignments/${created.body.id}`)
      .set(asAdmin())
      .send({ serviceLevelId: other.body.id });
    expect(changed.status).toBe(200);
    expect(changed.body.serviceLevel.name).toBe('Other');

    const cleared = await api
      .put(`/api/consignments/${created.body.id}`)
      .set(asAdmin())
      .send({ serviceLevelId: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.serviceLevel).toBeNull();
  });
});
