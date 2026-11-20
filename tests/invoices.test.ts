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

/*
 * Invoicing, end to end: price a delivered job from a rate card, put it on an
 * invoice, correct it, lock it, print it.
 *
 * Self-cleaning on purpose, like tests/rateCards.test.ts. It creates its own
 * client, zone list, rate card and consignments and deletes exactly those ids
 * at the end. It never calls cleanConsignments() and never truncates, because
 * it runs against the shared project — see the warning in CLAUDE.md.
 */

const TIMEOUT = 180_000;

let ref: Reference;
let admin: string;
let operator: string;
let serviceLevelId: string;
let freightItemId: string;
let clientId: string;
let zoneListId: string;
let cardId: string;

const invoiceIds: string[] = [];
const consignmentIds: string[] = [];
const listIds: string[] = [];
const cardIds: string[] = [];
let clientIdToDrop: string | null = null;

let seq = 0;
const unique = (what: string) => `INV-${Date.now()}-${seq++}-${what}`;

const asAdmin = () => authHeader(admin);
const asOperator = () => authHeader(operator);

/** The receiver's postcode decides the zone, so every fixture shares one FSA. */
const FSA = 'M5A';
const DEST = 'M5A 1A1';

beforeAll(async () => {
  ref = await seedReference();
  admin = await getToken();
  operator = (
    await ensureConsoleUser({ email: `ops-inv@${TEST_DOMAIN}`, name: 'Ops INV', role: 'operator' })
  ).token;

  const [sl, fi] = await Promise.all([
    prisma.serviceLevel.findFirst({ where: { active: true }, select: { id: true } }),
    prisma.freightItem.findFirst({ where: { active: true }, select: { id: true } }),
  ]);
  if (!sl || !fi) throw new Error('Seed the service level and freight item catalogues first');
  serviceLevelId = sl.id;
  freightItemId = fi.id;

  // Its own customer, so the pool of uninvoiced jobs cannot be polluted by
  // anything else in the database.
  const client = await prisma.client.create({
    data: { name: unique('customer'), code: `IV${seq}${Date.now() % 10000}`, taxExempt: false },
    select: { id: true },
  });
  clientId = client.id;
  clientIdToDrop = client.id;

  // Zone list -> one zone holding the destination FSA.
  const list = await api.post('/api/zone-lists').set(asAdmin()).send({ name: unique('list') });
  zoneListId = list.body.id;
  listIds.push(zoneListId);

  const zone = await api
    .post(`/api/zone-lists/${zoneListId}/zones`)
    .set(asAdmin())
    .send({ name: 'Downtown' });
  await api
    .put(`/api/zone-lists/${zoneListId}/zones/${zone.body.id}/codes`)
    .set(asAdmin())
    .send({ text: FSA })
    .expect(200);

  // A card with a 50% levy, so the levy arithmetic is visible and non-trivial.
  const card = await api.post('/api/rate-cards').set(asAdmin()).send({
    name: unique('card'),
    clientId,
    zoneListId,
    validFrom: '2020-01-01',
    validTo: '2040-12-31',
    levyPct: 50,
  });
  if (card.status !== 201) throw new Error(`card: ${card.status} ${JSON.stringify(card.body)}`);
  cardId = card.body.id;
  cardIds.push(cardId);

  // $100 flat, nothing per km or per minute: the test is about the ladder, not
  // about Google Routes, which is never reached because the fixtures have no
  // coordinates.
  await api
    .put(`/api/rate-cards/${cardId}/rates`)
    .set(asAdmin())
    .send({
      serviceLevelId,
      freightItemId,
      toZoneId: zone.body.id,
      baseRate: 100,
      ratePerKm: 0,
      freeKm: 0,
      waitRatePerMinute: 0,
      freeWaitMinutes: 0,
    })
    .expect(200);
});

afterAll(async () => {
  if (invoiceIds.length) await prisma.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
  if (consignmentIds.length) {
    await prisma.consignment.deleteMany({ where: { id: { in: consignmentIds } } });
  }
  if (cardIds.length) await prisma.rateCard.deleteMany({ where: { id: { in: cardIds } } });
  if (listIds.length) await prisma.zoneList.deleteMany({ where: { id: { in: listIds } } });
  if (clientIdToDrop) await prisma.client.deleteMany({ where: { id: clientIdToDrop } });
});

/**
 * Requested times on a future weekday, inside or outside business hours.
 *
 * Pinned rather than relative-to-now because the After Hours charge is judged
 * on these very fields: a fixture built from `Date.now()` prices differently
 * depending on what time the suite happens to run, which is how a green test
 * turns red overnight for no reason at all.
 */
function window(fromHour: number, toHour: number) {
  const d = new Date();
  d.setDate(d.getDate() + 3);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  const at = (h: number) => {
    const x = new Date(d);
    x.setHours(h, 0, 0, 0);
    return x.toISOString();
  };
  return {
    pickupAfter: at(fromHour),
    pickupBefore: at(fromHour + 1),
    deliverAfter: at(toHour - 1),
    deliverBefore: at(toHour),
  };
}

/** 10:00 to 14:00 on a weekday — comfortably inside any sane window. */
const IN_HOURS = () => window(10, 14);
/** 21:00 to 23:00 — outside both the weekday and the weekend window. */
const AFTER_HOURS = () => window(21, 23);

/**
 * A delivered job.
 *
 * The status is set directly rather than walked through the lifecycle: reaching
 * DELIVERED legitimately needs a photo and a signature uploaded to Storage, and
 * none of that is what this suite is testing.
 */
async function deliveredJob(overrides: Record<string, unknown> = {}): Promise<string> {
  const payload = buildConsignment(clientId, {
    serviceLevelId,
    freightItemId,
    ...IN_HOURS(),
    receiver: {
      name: 'Receiver One',
      line1: '1 King St W',
      province: 'ON',
      city: 'Toronto',
      postcode: DEST,
    },
    ...overrides,
  });

  const res = await api.post('/api/consignments').set(asOperator()).send(payload);
  if (res.status !== 201) throw new Error(`job: ${res.status} ${JSON.stringify(res.body)}`);
  consignmentIds.push(res.body.id);

  /*
   * A driver comes with the status. The database enforces
   * `driverId IS NULL` if and only if `status = 'UNASSIGNED'`, so a delivered
   * order with nobody against it is unrepresentable — correctly, since it
   * would mean a job that delivered itself.
   */
  await prisma.consignment.update({
    where: { id: res.body.id },
    data: {
      status: 'DELIVERED',
      driverId: ref.driverId,
      pickedUpAt: new Date(Date.now() - 3_600_000),
      deliveredAt: new Date(),
    },
  });
  return res.body.id;
}

const preview = (from = '2020-01-01', to = '2040-12-31') =>
  api.post('/api/invoices/preview').set(asOperator()).send({ clientId, from, to });

async function newInvoice(ids: string[]): Promise<string> {
  const res = await api
    .post('/api/invoices')
    .set(asOperator())
    .send({ clientId, consignmentIds: ids });
  if (res.status !== 201) throw new Error(`invoice: ${res.status} ${JSON.stringify(res.body)}`);
  invoiceIds.push(res.body.id);
  return res.body.id;
}

/* --------------------------------------------------------------- pricing */

describe('the money ladder', () => {
  it('prices base, then levy on base, then tax on the sub total', async () => {
    const job = await deliveredJob();
    const res = await preview();

    expect(res.status).toBe(200);
    expect(res.body.taxPct).toBe(13);

    const priced = res.body.jobs.find((j: { consignmentId: string }) => j.consignmentId === job);
    expect(priced).toBeDefined();
    expect(priced.ok).toBe(true);

    // 100 base -> levy 50% = 50 -> sub total 150 -> tax 13% = 19.50 -> 169.50
    expect(priced.baseAmount).toBe(100);
    expect(priced.levyAmount).toBe(50);
    expect(priced.taxAmount).toBe(19.5);
    expect(priced.grandTotal).toBe(169.5);
  }, TIMEOUT);

  it('charges no tax to an exempt customer, but still charges the levy', async () => {
    await prisma.client.update({ where: { id: clientId }, data: { taxExempt: true } });
    const job = await deliveredJob();

    const res = await preview();
    const priced = res.body.jobs.find((j: { consignmentId: string }) => j.consignmentId === job);

    expect(res.body.taxPct).toBe(0);
    expect(priced.levyAmount).toBe(50);
    expect(priced.taxAmount).toBe(0);
    expect(priced.grandTotal).toBe(150);

    await prisma.client.update({ where: { id: clientId }, data: { taxExempt: false } });
  }, TIMEOUT);

  it('prices a job that names no freight item, because matching is loose', async () => {
    const job = await deliveredJob({ freightItemId: undefined });
    await prisma.consignment.update({ where: { id: job }, data: { freightItemId: null } });

    const res = await preview();
    const priced = res.body.jobs.find((j: { consignmentId: string }) => j.consignmentId === job);

    expect(priced.ok).toBe(true);
    expect(priced.baseAmount).toBe(100);
  }, TIMEOUT);

  it('adds the After Hours charge when the requested times fall outside the window', async () => {
    const service = await prisma.additionalService.findFirst({
      where: { trigger: 'AFTER_HOURS', active: true },
      select: { id: true, name: true },
    });
    if (!service) return; // Nothing configured in this environment to assert on.

    const inside = await deliveredJob();
    const outside = await deliveredJob({ ...AFTER_HOURS() });

    const res = await preview();
    const find = (id: string) =>
      res.body.jobs.find((j: { consignmentId: string }) => j.consignmentId === id);

    // Same card, same zone, same base — the only difference is the clock.
    expect(find(inside).serviceAmount).toBe(0);
    expect(find(outside).serviceAmount).toBeGreaterThan(0);

    const line = find(outside).lines.find(
      (l: { kind: string }) => l.kind === 'SERVICE',
    );
    expect(line.key).toBe(`service:${service.id}`);

    // Charged once, not once per end, even though both ends are out of hours.
    const serviceLines = find(outside).lines.filter((l: { kind: string }) => l.kind === 'SERVICE');
    expect(serviceLines).toHaveLength(1);

    // And the levy still ignores it: 50% of the carriage alone.
    expect(find(outside).levyAmount).toBe(50);
  }, TIMEOUT);

  it('reports why a job cannot be priced instead of dropping it from the run', async () => {
    const job = await deliveredJob({
      receiver: {
        name: 'Nowhere',
        line1: '1 Nowhere Rd',
        province: 'BC',
        city: 'Vancouver',
        // A real FSA, but not one this card's zone list holds.
        postcode: 'V6B 1A1',
      },
    });

    const res = await preview();
    const priced = res.body.jobs.find((j: { consignmentId: string }) => j.consignmentId === job);

    expect(priced).toBeDefined();
    expect(priced.ok).toBe(false);
    expect(priced.problem).toBeTruthy();
    // Still listed, so nobody loses revenue to a silent filter.
    expect(priced.grandTotal).toBe(0);
  }, TIMEOUT);
});

/* -------------------------------------------------------------- lifecycle */

describe('an invoice', () => {
  it('takes delivered jobs, totals them, and removes them from the pool', async () => {
    const a = await deliveredJob();
    const b = await deliveredJob();

    const id = await newInvoice([a, b]);
    const res = await api.get(`/api/invoices/${id}`).set(asOperator());

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('OPEN');
    expect(res.body.lines).toHaveLength(2);
    expect(res.body.baseTotal).toBe(200);
    expect(res.body.levyTotal).toBe(100);
    expect(res.body.taxTotal).toBe(39);
    expect(res.body.grandTotal).toBe(339);
    expect(res.body.createdBy.id).toBeTruthy();

    // Both jobs have left the uninvoiced pool.
    const after = await preview();
    const ids = after.body.jobs.map((j: { consignmentId: string }) => j.consignmentId);
    expect(ids).not.toContain(a);
    expect(ids).not.toContain(b);
  }, TIMEOUT);

  it('refuses the same job on a second invoice', async () => {
    const job = await deliveredJob();
    await newInvoice([job]);

    const res = await api
      .post('/api/invoices')
      .set(asOperator())
      .send({ clientId, consignmentIds: [job] });

    expect(res.status).toBe(400);
  }, TIMEOUT);

  it('will not invoice a job that is not delivered', async () => {
    const payload = buildConsignment(clientId, {
      serviceLevelId,
      freightItemId,
      ...IN_HOURS(),
      receiver: {
        name: 'Not yet',
        line1: '2 King St W',
        province: 'ON',
        city: 'Toronto',
        postcode: DEST,
      },
    });
    const made = await api.post('/api/consignments').set(asOperator()).send(payload);
    consignmentIds.push(made.body.id);

    const res = await api
      .post('/api/invoices')
      .set(asOperator())
      .send({ clientId, consignmentIds: [made.body.id] });

    expect(res.status).toBe(400);
  }, TIMEOUT);

  it('recomputes the levy and the tax when the base is edited by hand', async () => {
    const job = await deliveredJob();
    const id = await newInvoice([job]);
    const before = await api.get(`/api/invoices/${id}`).set(asOperator());
    const lineId = before.body.lines[0].id;

    const res = await api
      .patch(`/api/invoices/${id}/lines/${lineId}`)
      .set(asOperator())
      .send({ baseAmount: 200 });

    expect(res.status).toBe(200);
    const line = res.body.lines[0];
    expect(line.baseAmount).toBe(200);
    expect(line.levyAmount).toBe(100); // 50% of 200
    expect(line.taxAmount).toBe(39); // 13% of 300
    expect(line.grandTotal).toBe(339);
    expect(line.edited).toBe(true);

    // And the header followed.
    expect(res.body.grandTotal).toBe(339);
  }, TIMEOUT);

  it('adds a manual line that the levy ignores but the tax does not', async () => {
    const job = await deliveredJob();
    const id = await newInvoice([job]);
    const before = await api.get(`/api/invoices/${id}`).set(asOperator());
    const lineId = before.body.lines[0].id;

    const res = await api
      .patch(`/api/invoices/${id}/lines/${lineId}`)
      .set(asOperator())
      .send({ manualLines: [{ label: 'Pallet wrap', amount: 20 }] });

    expect(res.status).toBe(200);
    const line = res.body.lines[0];
    expect(line.serviceAmount).toBe(20);
    // Levy still 50% of the carriage alone, exactly as the real invoices read.
    expect(line.levyAmount).toBe(50);
    // Tax on 100 + 20 + 50 = 170.
    expect(line.taxAmount).toBe(22.1);
    expect(line.grandTotal).toBe(192.1);
  }, TIMEOUT);

  it('puts an edited job back on the rate card when repriced', async () => {
    const job = await deliveredJob();
    const id = await newInvoice([job]);
    const before = await api.get(`/api/invoices/${id}`).set(asOperator());
    const lineId = before.body.lines[0].id;

    await api
      .patch(`/api/invoices/${id}/lines/${lineId}`)
      .set(asOperator())
      .send({ baseAmount: 999 })
      .expect(200);

    const res = await api
      .post(`/api/invoices/${id}/lines/${lineId}/reprice`)
      .set(asOperator());

    expect(res.status).toBe(200);
    expect(res.body.lines[0].baseAmount).toBe(100);
    expect(res.body.lines[0].edited).toBe(false);
  }, TIMEOUT);

  it('returns a removed job to the pool', async () => {
    const job = await deliveredJob();
    const id = await newInvoice([job]);
    const before = await api.get(`/api/invoices/${id}`).set(asOperator());

    const res = await api
      .delete(`/api/invoices/${id}/lines/${before.body.lines[0].id}`)
      .set(asOperator());

    expect(res.status).toBe(200);
    expect(res.body.lines).toHaveLength(0);
    expect(res.body.grandTotal).toBe(0);

    const after = await preview();
    expect(after.body.jobs.map((j: { consignmentId: string }) => j.consignmentId)).toContain(job);
  }, TIMEOUT);
});

/* --------------------------------------------------------------- approval */

describe('closing and approving', () => {
  it('stops jobs joining once closed, but still allows a price fix', async () => {
    const a = await deliveredJob();
    const b = await deliveredJob();
    const id = await newInvoice([a]);

    await api.patch(`/api/invoices/${id}`).set(asOperator()).send({ status: 'CLOSED' }).expect(200);

    const add = await api
      .post(`/api/invoices/${id}/lines`)
      .set(asOperator())
      .send({ consignmentIds: [b] });
    expect(add.status).toBe(409);

    const detail = await api.get(`/api/invoices/${id}`).set(asOperator());
    const fix = await api
      .patch(`/api/invoices/${id}/lines/${detail.body.lines[0].id}`)
      .set(asOperator())
      .send({ baseAmount: 120 });
    expect(fix.status).toBe(200);
  }, TIMEOUT);

  it('freezes everything on approval and names who did it', async () => {
    const job = await deliveredJob();
    const id = await newInvoice([job]);
    const detail = await api.get(`/api/invoices/${id}`).set(asOperator());
    const lineId = detail.body.lines[0].id;

    const approved = await api.post(`/api/invoices/${id}/approve`).set(asAdmin());
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('APPROVED');
    expect(approved.body.approvedBy.id).toBeTruthy();
    expect(approved.body.approvedAt).toBeTruthy();

    // Every way in is shut.
    await api
      .patch(`/api/invoices/${id}/lines/${lineId}`)
      .set(asOperator())
      .send({ baseAmount: 1 })
      .expect(409);
    await api.delete(`/api/invoices/${id}/lines/${lineId}`).set(asOperator()).expect(409);
    await api
      .patch(`/api/invoices/${id}`)
      .set(asOperator())
      .send({ status: 'OPEN' })
      .expect(409);
    await api.delete(`/api/invoices/${id}`).set(asAdmin()).expect(409);
  }, TIMEOUT);

  it('clears the approval stamps when un-approved, so no one signs twice', async () => {
    const job = await deliveredJob();
    const id = await newInvoice([job]);
    await api.post(`/api/invoices/${id}/approve`).set(asAdmin()).expect(200);

    const res = await api.post(`/api/invoices/${id}/unapprove`).set(asAdmin());
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CLOSED');
    expect(res.body.approvedBy).toBeNull();
    expect(res.body.approvedAt).toBeNull();

    // Editable again.
    const detail = await api.get(`/api/invoices/${id}`).set(asOperator());
    await api
      .patch(`/api/invoices/${id}/lines/${detail.body.lines[0].id}`)
      .set(asOperator())
      .send({ baseAmount: 150 })
      .expect(200);
  }, TIMEOUT);

  it('will not approve an invoice with nothing on it', async () => {
    const job = await deliveredJob();
    const id = await newInvoice([job]);
    const detail = await api.get(`/api/invoices/${id}`).set(asOperator());
    await api
      .delete(`/api/invoices/${id}/lines/${detail.body.lines[0].id}`)
      .set(asOperator())
      .expect(200);

    const res = await api.post(`/api/invoices/${id}/approve`).set(asAdmin());
    expect(res.status).toBe(409);
  }, TIMEOUT);

  it('lets only an admin approve', async () => {
    const job = await deliveredJob();
    const id = await newInvoice([job]);

    const res = await api.post(`/api/invoices/${id}/approve`).set(asOperator());
    expect(res.status).toBe(403);
  }, TIMEOUT);
});

/* ------------------------------------------------------------------ print */

describe('the printed invoice', () => {
  it('renders a PDF with the levy grouped by its rate', async () => {
    const a = await deliveredJob();
    const b = await deliveredJob();
    const id = await newInvoice([a, b]);

    const detail = await api.get(`/api/invoices/${id}`).set(asOperator());
    // Both jobs came off the same card, so one levy line at 50%.
    expect(detail.body.levyBreakdown).toEqual([{ pct: 50, amount: 100, label: 'Levy 50%' }]);

    const res = await api.get(`/api/invoices/${id}/invoice.pdf`).set(asOperator());
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.body.slice(0, 5).toString()).toBe('%PDF-');
    expect(res.body.length).toBeGreaterThan(1000);
  }, TIMEOUT);
});

/* --------------------------------------------------------------- settings */

describe('finance settings', () => {
  it('is readable by an operator and writable only by an admin', async () => {
    const read = await api.get('/api/invoices/settings').set(asOperator());
    expect(read.status).toBe(200);
    expect(read.body.taxPct).toBe(13);

    await api.put('/api/invoices/settings').set(asOperator()).send({ taxPct: 5 }).expect(403);
  }, TIMEOUT);
});
