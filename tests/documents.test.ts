import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  TEST_DOMAIN,
  api,
  authHeader,
  ensureConsoleUser,
  getDriverToken,
  getToken,
  prisma,
  seedReference,
  type Reference,
} from './helpers/api.js';
import { buildConsignment } from './helpers/factory.js';

let ref: Reference;
let admin: string;
let operator: string;
let driverToken: string;
const createdIds: string[] = [];

beforeAll(async () => {
  ref = await seedReference();
  admin = await getToken();
  operator = (
    await ensureConsoleUser({ email: `ops-doc@${TEST_DOMAIN}`, name: 'Ops DOC', role: 'operator' })
  ).token;
  driverToken = await getDriverToken(ref.driverId);
});

afterAll(async () => {
  // Only what this suite made — no truncation, so it is safe against a shared db.
  if (createdIds.length) {
    await prisma.consignment.deleteMany({ where: { id: { in: createdIds } } });
  }
});

const asAdmin = () => authHeader(admin);
const asOperator = () => authHeader(operator);
const asDriver = () => authHeader(driverToken);

/**
 * pdfkit compresses content streams but not the page tree, so the catalog's
 * `/Count` is a reliable page count without pulling in a PDF parser.
 */
function pageCount(body: Buffer): number {
  const m = /\/Count (\d+)/.exec(body.toString('latin1'));
  return m ? Number(m[1]) : 0;
}

function isPdf(body: Buffer): boolean {
  return body.subarray(0, 5).toString('ascii') === '%PDF-';
}

/** The fixture carries two item lines, qty 1 and qty 2 — three pieces in total. */
const FIXTURE_PIECES = 3;

async function order() {
  const created = await api
    .post('/api/consignments')
    .set(asAdmin())
    .send(buildConsignment(ref.clientId));
  if (created.status !== 201) {
    throw new Error(`create failed: ${created.status} ${JSON.stringify(created.body)}`);
  }
  const id = created.body.id as string;
  createdIds.push(id);
  return id;
}

describe('printing labels', () => {
  it('returns one 4x6 label per piece', async () => {
    const id = await order();

    const res = await api
      .get(`/api/consignments/${id}/label.pdf`)
      .set(asOperator())
      .responseType('blob');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toContain('-labels.pdf');
    expect(isPdf(res.body as Buffer)).toBe(true);
    expect(pageCount(res.body as Buffer)).toBe(FIXTURE_PIECES);
  });

  it('is never cached — a reprint after an edit must show the edit', async () => {
    const id = await order();

    const res = await api.get(`/api/consignments/${id}/label.pdf`).set(asOperator());
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('printing the docket', () => {
  it('returns one A4 sheet carrying both copies', async () => {
    const id = await order();

    const res = await api
      .get(`/api/consignments/${id}/docket.pdf`)
      .set(asOperator())
      .responseType('blob');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toContain('-docket.pdf');
    expect(isPdf(res.body as Buffer)).toBe(true);
    // Two copies on one sheet, not two pages — the operator cuts it in half.
    expect(pageCount(res.body as Buffer)).toBe(1);
  });
});

describe('who may print', () => {
  it('is operator+ — a driver cannot pull the paperwork', async () => {
    const id = await order();

    const label = await api.get(`/api/consignments/${id}/label.pdf`).set(asDriver());
    const docket = await api.get(`/api/consignments/${id}/docket.pdf`).set(asDriver());

    expect(label.status).toBe(403);
    expect(docket.status).toBe(403);
  });

  it('requires a token', async () => {
    const id = await order();

    const res = await api.get(`/api/consignments/${id}/label.pdf`);
    expect(res.status).toBe(401);
  });

  it('is 404 for an order that does not exist', async () => {
    const res = await api
      .get('/api/consignments/ckzzzzzzzzzzzzzzzzzzzzzzz/label.pdf')
      .set(asOperator());

    expect(res.status).toBe(404);
  });
});
