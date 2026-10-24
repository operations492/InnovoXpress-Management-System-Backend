import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  TEST_DOMAIN,
  api,
  authHeader,
  ensureConsoleUser,
  getToken,
  prisma,
  seedReference,
  type Reference,
} from './helpers/api.js';
import { buildConsignment } from './helpers/factory.js';

/**
 * The two list filters the console's search needs and the API did not have:
 * `taskType`, and `deliverBy` (a delivery-deadline bound, as opposed to
 * `from`/`to` which bound `createdAt`).
 */
let ref: Reference;
let admin: string;
let operator: string;
const createdIds: string[] = [];

beforeAll(async () => {
  ref = await seedReference();
  admin = await getToken();
  operator = (
    await ensureConsoleUser({ email: `ops-lf@${TEST_DOMAIN}`, name: 'Ops LF', role: 'operator' })
  ).token;
});

afterAll(async () => {
  if (createdIds.length) {
    await prisma.consignment.deleteMany({ where: { id: { in: createdIds } } });
  }
});

const asAdmin = () => authHeader(admin);
const asOperator = () => authHeader(operator);

const HOUR = 3_600_000;

async function make(over: Record<string, unknown>) {
  const res = await api
    .post('/api/consignments')
    .set(asAdmin())
    .send(buildConsignment(ref.clientId, over));
  if (res.status !== 201) {
    throw new Error(`create failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  const id = res.body.id as string;
  createdIds.push(id);
  return id;
}

/** Scoped by a unique clientReference so other rows in the table cannot leak in. */
async function listBy(params: Record<string, string>, q: string) {
  const res = await api.get('/api/consignments').set(asOperator()).query({ ...params, q });
  expect(res.status).toBe(200);
  return res.body.data as Array<{ id: string }>;
}

describe('taskType filter', () => {
  it('returns only the requested type', async () => {
    const tag = `LFT-${Date.now()}`;
    const delivery = await make({ clientReference: `${tag}-D`, taskType: 'DELIVERY' });
    const pickup = await make({ clientReference: `${tag}-P`, taskType: 'PICKUP' });
    const both = await make({ clientReference: `${tag}-B`, taskType: 'PICKUP_AND_DELIVERY' });

    const deliveries = await listBy({ taskType: 'DELIVERY' }, tag);
    const ids = deliveries.map((r) => r.id);
    expect(ids).toContain(delivery);
    expect(ids).not.toContain(pickup);
    expect(ids).not.toContain(both);

    const combined = await listBy({ taskType: 'PICKUP_AND_DELIVERY' }, tag);
    expect(combined.map((r) => r.id)).toEqual([both]);
  });

  it('rejects a value outside the enum rather than ignoring it', async () => {
    const res = await api
      .get('/api/consignments')
      .set(asOperator())
      .query({ taskType: 'All' });

    expect(res.status).toBe(400);
  });
});

describe('deliverBy filter', () => {
  it('keeps orders due on or before the date, and drops later ones', async () => {
    const tag = `LFD-${Date.now()}`;
    const now = Date.now();
    const soon = new Date(now + 2 * HOUR).toISOString();
    const later = new Date(now + 72 * HOUR).toISOString();

    const dueSoon = await make({
      clientReference: `${tag}-S`,
      pickupAfter: new Date(now).toISOString(),
      pickupBefore: soon,
      deliverAfter: new Date(now + HOUR).toISOString(),
      deliverBefore: soon,
    });
    const dueLater = await make({
      clientReference: `${tag}-L`,
      pickupAfter: new Date(now).toISOString(),
      pickupBefore: later,
      deliverAfter: new Date(now + HOUR).toISOString(),
      deliverBefore: later,
    });

    // Bound on the soon order's own date rather than "today", so the assertion
    // does not flip when the suite runs within two hours of midnight.
    const bound = soon.slice(0, 10);
    const ids = (await listBy({ deliverBy: bound }, tag)).map((r) => r.id);

    expect(ids).toContain(dueSoon);
    expect(ids).not.toContain(dueLater);
  });

  it('bounds the delivery deadline, not createdAt', async () => {
    const tag = `LFX-${Date.now()}`;
    const now = Date.now();
    const id = await make({
      clientReference: `${tag}-1`,
      pickupAfter: new Date(now).toISOString(),
      pickupBefore: new Date(now + 48 * HOUR).toISOString(),
      deliverAfter: new Date(now + HOUR).toISOString(),
      deliverBefore: new Date(now + 48 * HOUR).toISOString(),
    });

    // Created right now, so a createdAt-based filter would have matched today.
    const today = new Date(now).toISOString().slice(0, 10);
    expect((await listBy({ deliverBy: today }, tag)).map((r) => r.id)).not.toContain(id);

    const inThreeDays = new Date(now + 72 * HOUR).toISOString().slice(0, 10);
    expect((await listBy({ deliverBy: inThreeDays }, tag)).map((r) => r.id)).toContain(id);
  });
});
