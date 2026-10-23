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
import { JPEG_1X1, PNG_1X1, WEBP_HEADER } from './helpers/files.js';
import { POD_BUCKET, supabase } from '../src/config/supabase.js';

/**
 * The POD report: the one document gated on the lifecycle, and the one that
 * reads data captured by the phone rather than typed by a dispatcher.
 *
 * Self-cleaning on purpose — it deletes only the orders it created and the
 * storage objects it wrote. It must never call `cleanConsignments()`, which
 * truncates every operational table including the proofs this suite is about.
 */

let ref: Reference;
let admin: string;
let operator: string;
let driverToken: string;
const createdIds: string[] = [];
/** Only true if this suite wrote the row, so teardown never removes live state. */
let positionWasOurs = false;

beforeAll(async () => {
  ref = await seedReference();
  admin = await getToken();
  operator = (
    await ensureConsoleUser({ email: `ops-podrep@${TEST_DOMAIN}`, name: 'Ops PODREP', role: 'operator' })
  ).token;
  driverToken = await getDriverToken(ref.driverId);
});

afterAll(async () => {
  // Only what this suite made — no truncation, so it is safe against a shared db.
  if (createdIds.length) {
    const paths = createdIds.flatMap((id) =>
      ['PICKUP', 'DELIVERY'].flatMap((leg) =>
        ['photo', 'signature'].flatMap((kind) =>
          ['png', 'jpg', 'webp'].map((ext) => `${id}/${leg}/${kind}.${ext}`),
        ),
      ),
    );
    // Storage is not transactional, so objects have to be swept explicitly.
    await supabase.storage.from(POD_BUCKET).remove(paths);
    await prisma.consignment.deleteMany({ where: { id: { in: createdIds } } });
  }

  if (positionWasOurs) {
    await prisma.driverPosition.deleteMany({ where: { driverId: ref.driverId } });
  }
});

const asAdmin = () => authHeader(admin);
const asOperator = () => authHeader(operator);
const asDriver = () => authHeader(driverToken);

/** See documents.test.ts — pdfkit leaves the page tree uncompressed. */
function pageCount(body: Buffer): number {
  const m = /\/Count (\d+)/.exec(body.toString('latin1'));
  return m ? Number(m[1]) : 0;
}

function isPdf(body: Buffer): boolean {
  return body.subarray(0, 5).toString('ascii') === '%PDF-';
}

async function newOrder(): Promise<string> {
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

/** The whole happy path: assign, walk the manual steps, prove both legs. */
async function deliveredOrder(photo: Buffer = PNG_1X1, ext = 'png'): Promise<string> {
  const id = await newOrder();

  await api.post(`/api/consignments/${id}/assign`).set(asAdmin()).send({ driverId: ref.driverId });
  await api.patch(`/api/consignments/${id}/status`).set(asAdmin()).send({ status: 'EN_ROUTE_TO_PICKUP' });
  await api.patch(`/api/consignments/${id}/status`).set(asAdmin()).send({ status: 'AT_PICKUP' });

  const pickup = await api
    .post(`/api/consignments/${id}/pod/pickup`)
    .set(asAdmin())
    .field('signedByName', 'Warehouse Supervisor')
    .field('itemCount', '3')
    .attach('photo', photo, `photo.${ext}`)
    .attach('signature', PNG_1X1, 'signature.png');
  if (pickup.status !== 201) {
    throw new Error(`pickup pod failed: ${pickup.status} ${JSON.stringify(pickup.body)}`);
  }

  await api.patch(`/api/consignments/${id}/status`).set(asAdmin()).send({ status: 'EN_ROUTE_TO_DELIVERY' });
  await api.patch(`/api/consignments/${id}/status`).set(asAdmin()).send({ status: 'AT_DELIVERY' });

  const delivery = await api
    .post(`/api/consignments/${id}/pod/delivery`)
    .set(asAdmin())
    .field('signedByName', 'Kelly Bradley')
    .field('itemCount', '3')
    .attach('photo', photo, `photo.${ext}`)
    .attach('signature', JPEG_1X1, 'signature.jpg');
  if (delivery.status !== 201) {
    throw new Error(`delivery pod failed: ${delivery.status} ${JSON.stringify(delivery.body)}`);
  }

  return id;
}

describe('printing the POD report', () => {
  it('returns the report sheet plus a page of photographs', async () => {
    const id = await deliveredOrder();

    const res = await api
      .get(`/api/consignments/${id}/pod-report.pdf`)
      .set(asOperator())
      .responseType('blob');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toContain('-pod-report.pdf');
    expect(isPdf(res.body as Buffer)).toBe(true);
    // One report sheet; both proofs' photos fit on a single picture page.
    expect(pageCount(res.body as Buffer)).toBe(2);
  });

  it('is never cached — a reprint must show the latest proof', async () => {
    const id = await deliveredOrder();

    const res = await api.get(`/api/consignments/${id}/pod-report.pdf`).set(asOperator());

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('still renders when a photo is a format pdfkit cannot embed', async () => {
    // WebP passes the POD sniffer and cannot be drawn. The report must print a
    // labelled gap, not fail — this is the one case that would 500 in the field.
    const id = await deliveredOrder(WEBP_HEADER, 'webp');

    const res = await api
      .get(`/api/consignments/${id}/pod-report.pdf`)
      .set(asOperator())
      .responseType('blob');

    expect(res.status).toBe(200);
    expect(isPdf(res.body as Buffer)).toBe(true);
    // The picture page is still there, with a framed gap per stop: a photo WAS
    // taken, and silently dropping the block would shorten the evidence.
    expect(pageCount(res.body as Buffer)).toBe(2);
  });
});

describe('the report is gated on the lifecycle', () => {
  it('refuses an order that has not been delivered', async () => {
    const id = await newOrder();
    await api.post(`/api/consignments/${id}/assign`).set(asAdmin()).send({ driverId: ref.driverId });

    const res = await api.get(`/api/consignments/${id}/pod-report.pdf`).set(asOperator());

    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/delivered/i);
  });

  it('refuses an order that is still in motion', async () => {
    const id = await newOrder();
    await api.post(`/api/consignments/${id}/assign`).set(asAdmin()).send({ driverId: ref.driverId });
    await api.patch(`/api/consignments/${id}/status`).set(asAdmin()).send({ status: 'EN_ROUTE_TO_PICKUP' });

    const res = await api.get(`/api/consignments/${id}/pod-report.pdf`).set(asOperator());

    expect(res.status).toBe(409);
  });
});

describe('who may print the POD report', () => {
  it('is operator+ — a driver cannot pull the paperwork', async () => {
    const id = await deliveredOrder();

    const res = await api.get(`/api/consignments/${id}/pod-report.pdf`).set(asDriver());

    expect(res.status).toBe(403);
  });

  it('requires a token', async () => {
    const id = await deliveredOrder();

    const res = await api.get(`/api/consignments/${id}/pod-report.pdf`);

    expect(res.status).toBe(401);
  });

  it('is 404 for an order that does not exist', async () => {
    const res = await api
      .get('/api/consignments/ckzzzzzzzzzzzzzzzzzzzzzzz/pod-report.pdf')
      .set(asOperator());

    expect(res.status).toBe(404);
  });
});

describe('the coordinate snapshot', () => {
  it('copies the driver live position onto the proof at capture', async () => {
    // The phone sends no coordinate; the capture transaction reads the position
    // the driver has been reporting anyway. Seed one so there is something to read.
    const fixAt = new Date(Date.now() - 4 * 60_000);
    await prisma.driverPosition.upsert({
      where: { driverId: ref.driverId },
      create: { driverId: ref.driverId, lat: 43.653264, lng: -79.382894, accuracyM: 12, recordedAt: fixAt },
      update: { lat: 43.653264, lng: -79.382894, accuracyM: 12, recordedAt: fixAt },
    });
    positionWasOurs = true;

    const id = await deliveredOrder();

    const proofs = await prisma.proofOfDelivery.findMany({
      where: { consignmentId: id },
      orderBy: { capturedAt: 'asc' },
    });

    expect(proofs).toHaveLength(2);
    for (const p of proofs) {
      expect(p.podLat).toBeCloseTo(43.653264, 5);
      expect(p.podLng).toBeCloseTo(-79.382894, 5);
      expect(p.podAccuracyM).toBe(12);
      // The device's fix time, not the moment of capture — they differ by design.
      expect(p.podFixAt?.getTime()).toBe(fixAt.getTime());
      expect(p.podFixAt!.getTime()).toBeLessThan(p.capturedAt.getTime());
    }
  });

  it('still captures a proof when the driver has never reported a position', async () => {
    await prisma.driverPosition.deleteMany({ where: { driverId: ref.driverBId } });

    const id = await newOrder();
    await api.post(`/api/consignments/${id}/assign`).set(asAdmin()).send({ driverId: ref.driverBId });
    await api.patch(`/api/consignments/${id}/status`).set(asAdmin()).send({ status: 'EN_ROUTE_TO_PICKUP' });
    await api.patch(`/api/consignments/${id}/status`).set(asAdmin()).send({ status: 'AT_PICKUP' });

    const res = await api
      .post(`/api/consignments/${id}/pod/pickup`)
      .set(asAdmin())
      .attach('photo', PNG_1X1, 'photo.png')
      .attach('signature', PNG_1X1, 'signature.png');

    expect(res.status).toBe(201);

    const proof = await prisma.proofOfDelivery.findFirst({ where: { consignmentId: id } });
    expect(proof).not.toBeNull();
    expect(proof!.podLat).toBeNull();
    expect(proof!.podFixAt).toBeNull();
  });
});
