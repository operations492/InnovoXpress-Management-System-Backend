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
import { NOT_AN_IMAGE, PNG_1X1 } from './helpers/files.js';
import { supabase, ORDER_DOCS_BUCKET } from '../src/config/supabase.js';

/**
 * The same `%PDF-` buffer POD rejects. That asymmetry is the feature: a signature
 * must be an image, a release letter is normally a PDF.
 */
const PDF = NOT_AN_IMAGE;

let ref: Reference;
let admin: string;
let operator: string;
let driverToken: string;
let driverBToken: string;
const createdIds: string[] = [];

beforeAll(async () => {
  ref = await seedReference();
  admin = await getToken();
  operator = (
    await ensureConsoleUser({ email: `ops-rl@${TEST_DOMAIN}`, name: 'Ops RL', role: 'operator' })
  ).token;
  driverToken = await getDriverToken(ref.driverId);
  driverBToken = await getDriverToken(ref.driverBId);
});

afterAll(async () => {
  // Storage is not transactional and the object name carries a random segment, so
  // the suite's files have to be listed and swept or they pile up in a real bucket.
  for (const id of createdIds) {
    const { data } = await supabase.storage.from(ORDER_DOCS_BUCKET).list(id);
    const paths = (data ?? []).map((o) => `${id}/${o.name}`);
    if (paths.length) await supabase.storage.from(ORDER_DOCS_BUCKET).remove(paths);
  }

  // Deliberately NOT `cleanConsignments()`, and no `beforeEach` at all: every case
  // here creates its own order and asserts only on that one, so this suite has no
  // reason to truncate a shared database. It removes exactly what it made — items,
  // proofs and tracking events cascade with the consignment.
  if (createdIds.length) {
    await prisma.consignment.deleteMany({ where: { id: { in: createdIds } } });
  }
});

const asAdmin = () => authHeader(admin);
const asOperator = () => authHeader(operator);
const asDriver = () => authHeader(driverToken);
const asDriverB = () => authHeader(driverBToken);

/** An order assigned to ref.driverId, which is the only driver allowed to read it. */
async function assignedOrder() {
  const created = await api
    .post('/api/consignments')
    .set(asAdmin())
    .send(buildConsignment(ref.clientId));
  // Fail here with the server's own message rather than letting an undefined id
  // turn one broken fixture into a dozen confusing 404s.
  if (created.status !== 201) {
    throw new Error(`create failed: ${created.status} ${JSON.stringify(created.body)}`);
  }
  const id = created.body.id as string;
  createdIds.push(id);

  await api.post(`/api/consignments/${id}/assign`).set(asAdmin()).send({ driverId: ref.driverId });
  return id;
}

describe('uploading a release letter', () => {
  it('stores a PDF and reports it on the order', async () => {
    const id = await assignedOrder();

    const before = await api.get(`/api/consignments/${id}`).set(asOperator());
    expect(before.body.hasReleaseLetter).toBe(false);

    const res = await api
      .post(`/api/consignments/${id}/release-letter`)
      .set(asOperator())
      .attach('file', PDF, { filename: 'release.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(200);
    expect(res.body.hasReleaseLetter).toBe(true);
    expect(res.body.releaseLetterUrl).toBeTruthy();

    const after = await api.get(`/api/consignments/${id}`).set(asOperator());
    expect(after.body.hasReleaseLetter).toBe(true);
  });

  it('accepts an image too, for a photographed letter', async () => {
    const id = await assignedOrder();

    const res = await api
      .post(`/api/consignments/${id}/release-letter`)
      .set(asOperator())
      .attach('file', PNG_1X1, 'letter.png');

    expect(res.status).toBe(200);
    expect(res.body.hasReleaseLetter).toBe(true);
  });

  it('replaces the previous letter rather than adding a second', async () => {
    const id = await assignedOrder();

    await api
      .post(`/api/consignments/${id}/release-letter`)
      .set(asOperator())
      .attach('file', PDF, { filename: 'first.pdf', contentType: 'application/pdf' });
    const second = await api
      .post(`/api/consignments/${id}/release-letter`)
      .set(asOperator())
      .attach('file', PNG_1X1, 'second.png');

    expect(second.status).toBe(200);

    const { data } = await supabase.storage.from(ORDER_DOCS_BUCKET).list(id);
    expect(data).toHaveLength(1);
  });

  it('rejects bytes that are neither a PDF nor an image', async () => {
    const id = await assignedOrder();

    const res = await api
      .post(`/api/consignments/${id}/release-letter`)
      .set(asOperator())
      .attach('file', Buffer.from('MZ\u0090\u0000 not a document'), {
        filename: 'evil.pdf',
        contentType: 'application/pdf',
      });

    expect(res.status).toBe(400);
  });

  it('is operator+ — a driver may not upload one', async () => {
    const id = await assignedOrder();

    const res = await api
      .post(`/api/consignments/${id}/release-letter`)
      .set(asDriver())
      .attach('file', PDF, { filename: 'release.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(403);
  });
});

describe('reading a release letter', () => {
  it('gives the assigned driver a signed link, and flags it in their job list', async () => {
    const id = await assignedOrder();
    await api
      .post(`/api/consignments/${id}/release-letter`)
      .set(asOperator())
      .attach('file', PDF, { filename: 'release.pdf', contentType: 'application/pdf' });

    const res = await api.get(`/api/consignments/${id}/release-letter`).set(asDriver());
    expect(res.status).toBe(200);
    expect(res.body.releaseLetterUrl).toContain('token=');

    const jobs = await api.get('/api/drivers/me/consignments').set(asDriver());
    const job = jobs.body.data.find((j: { id: string }) => j.id === id);
    expect(job.hasReleaseLetter).toBe(true);
    // The storage path is an internal detail; the phone gets a signed link or nothing.
    expect(job.releaseLetterPath).toBeUndefined();
  });

  it('returns a null url when no letter was uploaded', async () => {
    const id = await assignedOrder();

    const res = await api.get(`/api/consignments/${id}/release-letter`).set(asOperator());
    expect(res.status).toBe(200);
    expect(res.body.hasReleaseLetter).toBe(false);
    expect(res.body.releaseLetterUrl).toBeNull();
  });

  it('is 403 for a driver the order is not assigned to', async () => {
    const id = await assignedOrder();

    const res = await api.get(`/api/consignments/${id}/release-letter`).set(asDriverB());
    expect(res.status).toBe(403);
  });

  it('requires a token', async () => {
    const id = await assignedOrder();

    const res = await api.get(`/api/consignments/${id}/release-letter`);
    expect(res.status).toBe(401);
  });
});

describe('clearing a release letter', () => {
  it('removes both the column and the object', async () => {
    const id = await assignedOrder();
    await api
      .post(`/api/consignments/${id}/release-letter`)
      .set(asOperator())
      .attach('file', PDF, { filename: 'release.pdf', contentType: 'application/pdf' });

    const res = await api.delete(`/api/consignments/${id}/release-letter`).set(asOperator());
    expect(res.status).toBe(200);
    expect(res.body.hasReleaseLetter).toBe(false);

    const after = await api.get(`/api/consignments/${id}`).set(asOperator());
    expect(after.body.hasReleaseLetter).toBe(false);

    const { data } = await supabase.storage.from(ORDER_DOCS_BUCKET).list(id);
    expect(data ?? []).toHaveLength(0);
  });

  it('is a no-op, not an error, when there is nothing to clear', async () => {
    const id = await assignedOrder();

    const res = await api.delete(`/api/consignments/${id}/release-letter`).set(asOperator());
    expect(res.status).toBe(200);
    expect(res.body.hasReleaseLetter).toBe(false);
  });
});
