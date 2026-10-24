import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PDFDocument } from 'pdf-lib';
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
import { ORDER_DOCS_BUCKET, POD_BUCKET, supabase } from '../src/config/supabase.js';

/**
 * Order paperwork: two kinds of document, configured per stop, and the hard block
 * that stops a leg being closed while a required signature is missing.
 *
 * Self-cleaning on purpose — it deletes only the orders it created and the
 * storage objects it wrote. It must never call `cleanConsignments()`, which
 * truncates every operational table.
 */

/*
 * These tests are network-bound: every one drives the real API against a Supabase
 * project a region away, and the gate tests walk a whole order to a stop before
 * they can assert anything. Vitest's 30s default is not enough for that, and a
 * timeout here looks like a product bug when it is only latency.
 */
const TIMEOUT = 120_000;

let ref: Reference;
let admin: string;
let operator: string;
let driverToken: string;
let realPdf: Buffer;
const createdIds: string[] = [];

beforeAll(async () => {
  ref = await seedReference();
  admin = await getToken();
  operator = (
    await ensureConsoleUser({ email: `ops-docs@${TEST_DOMAIN}`, name: 'Ops DOCS', role: 'operator' })
  ).token;
  driverToken = await getDriverToken(ref.driverId);

  // A genuinely parseable PDF, so the stamping path is exercised for real. The
  // suite also uses NOT_AN_IMAGE, which passes the sniffer but cannot be parsed —
  // that is the graceful-degradation case.
  const doc = await PDFDocument.create();
  doc.addPage([595.28, 841.89]);
  realPdf = Buffer.from(await doc.save());
});

afterAll(async () => {
  if (!createdIds.length) return;

  // Document paths carry a random uuid, so they cannot be enumerated — list the
  // order's folder instead. Storage is not transactional either way.
  for (const id of createdIds) {
    const { data } = await supabase.storage.from(ORDER_DOCS_BUCKET).list(id);
    if (data?.length) {
      await supabase.storage.from(ORDER_DOCS_BUCKET).remove(data.map((o) => `${id}/${o.name}`));
    }
  }

  const podPaths = createdIds.flatMap((id) =>
    ['PICKUP', 'DELIVERY'].flatMap((leg) => [
      `${id}/${leg}/photo.png`,
      `${id}/${leg}/signature.png`,
    ]),
  );
  await supabase.storage.from(POD_BUCKET).remove(podPaths);

  // Only what this suite made — no truncation, so it is safe against a shared db.
  await prisma.consignment.deleteMany({ where: { id: { in: createdIds } } });
});

const asAdmin = () => authHeader(admin);
const asOperator = () => authHeader(operator);
const asDriver = () => authHeader(driverToken);

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

/** Walk an order to the point where a leg's proof can be captured. */
async function orderAt(status: 'AT_PICKUP' | 'AT_DELIVERY'): Promise<string> {
  const id = await newOrder();
  await api.post(`/api/consignments/${id}/assign`).set(asAdmin()).send({ driverId: ref.driverId });
  await api.patch(`/api/consignments/${id}/status`).set(asAdmin()).send({ status: 'EN_ROUTE_TO_PICKUP' });
  await api.patch(`/api/consignments/${id}/status`).set(asAdmin()).send({ status: 'AT_PICKUP' });
  if (status === 'AT_PICKUP') return id;

  await api
    .post(`/api/consignments/${id}/pod/pickup`)
    .set(asAdmin())
    .attach('photo', PNG_1X1, 'photo.png')
    .attach('signature', PNG_1X1, 'signature.png');
  await api.patch(`/api/consignments/${id}/status`).set(asAdmin()).send({ status: 'EN_ROUTE_TO_DELIVERY' });
  await api.patch(`/api/consignments/${id}/status`).set(asAdmin()).send({ status: 'AT_DELIVERY' });
  return id;
}

const attach = (id: string, kind: string, body: Buffer, name: string) =>
  api.post(`/api/consignments/${id}/documents/${kind}`).set(asOperator()).attach('file', body, name);

const capturePod = (id: string, leg: 'pickup' | 'delivery') =>
  api
    .post(`/api/consignments/${id}/pod/${leg}`)
    .set(asAdmin())
    .attach('photo', PNG_1X1, 'photo.png')
    .attach('signature', PNG_1X1, 'signature.png');

describe('attaching paperwork', () => {
  it('holds a release letter and a bill of lading side by side', async () => {
    const id = await newOrder();

    await attach(id, 'release-letter', realPdf, 'letter.pdf').expect(200);
    const res = await attach(id, 'bill-of-lading', PNG_1X1, 'bol.png');

    expect(res.status).toBe(200);
    expect(res.body.documents).toHaveLength(2);
    const kinds = res.body.documents.map((d: { kind: string }) => d.kind).sort();
    expect(kinds).toEqual(['BILL_OF_LADING', 'RELEASE_LETTER']);
  });

  it('defaults to shown at both stops and signed at neither', async () => {
    const id = await newOrder();

    const res = await attach(id, 'release-letter', realPdf, 'letter.pdf');

    const doc = res.body.documents[0];
    expect(doc.showAtPickup).toBe(true);
    expect(doc.showAtDelivery).toBe(true);
    expect(doc.signAtPickup).toBe(false);
    expect(doc.signAtDelivery).toBe(false);
  });

  it('keeps one row per kind — a replacement is not a second document', async () => {
    const id = await newOrder();

    await attach(id, 'release-letter', realPdf, 'first.pdf').expect(200);
    const res = await attach(id, 'release-letter', PNG_1X1, 'second.png');

    expect(res.body.documents).toHaveLength(1);
    expect(res.body.documents[0].mime).toBe('image/png');
  });

  it('rejects a file that is not a PDF or an image', async () => {
    const id = await newOrder();

    const res = await api
      .post(`/api/consignments/${id}/documents/release-letter`)
      .set(asOperator())
      .attach('file', Buffer.from('just text'), 'notes.txt');

    expect(res.status).toBe(400);
  });

  it('rejects an unknown document kind', async () => {
    const id = await newOrder();

    const res = await attach(id, 'packing-slip', realPdf, 'x.pdf');

    expect(res.status).toBe(400);
  });
});

describe('configuring which stops a document applies to', () => {
  it('saves one flag at a time without resetting the others', async () => {
    const id = await newOrder();
    await attach(id, 'release-letter', realPdf, 'letter.pdf').expect(200);

    const res = await api
      .patch(`/api/consignments/${id}/documents/release-letter`)
      .set(asOperator())
      .send({ showAtPickup: false });

    expect(res.status).toBe(200);
    expect(res.body.documents[0].showAtPickup).toBe(false);
    expect(res.body.documents[0].showAtDelivery).toBe(true);
  });

  it('forces the show flag on when signing is required at that stop', async () => {
    const id = await newOrder();
    await attach(id, 'bill-of-lading', realPdf, 'bol.pdf').expect(200);

    // Deliberately contradictory: sign here, but do not show here.
    const res = await api
      .patch(`/api/consignments/${id}/documents/bill-of-lading`)
      .set(asOperator())
      .send({ signAtDelivery: true, showAtDelivery: false });

    expect(res.status).toBe(200);
    expect(res.body.documents[0].signAtDelivery).toBe(true);
    // A document that must be signed but is never displayed would block the stop
    // with nothing on screen to explain why.
    expect(res.body.documents[0].showAtDelivery).toBe(true);
  });

  it('rejects an unknown flag rather than ignoring it', async () => {
    const id = await newOrder();
    await attach(id, 'release-letter', realPdf, 'letter.pdf').expect(200);

    const res = await api
      .patch(`/api/consignments/${id}/documents/release-letter`)
      .set(asOperator())
      .send({ signAtDropoff: true });

    expect(res.status).toBe(400);
  });
});

describe('what the driver sees at a stop', () => {
  it('returns only the documents ticked for that leg', async () => {
    const id = await newOrder();
    await attach(id, 'release-letter', realPdf, 'letter.pdf').expect(200);
    await attach(id, 'bill-of-lading', realPdf, 'bol.pdf').expect(200);
    await api
      .patch(`/api/consignments/${id}/documents/bill-of-lading`)
      .set(asOperator())
      .send({ showAtPickup: false, showAtDelivery: true })
      .expect(200);

    await api.post(`/api/consignments/${id}/assign`).set(asAdmin()).send({ driverId: ref.driverId });

    const pickup = await api
      .get(`/api/consignments/${id}/documents?leg=PICKUP`)
      .set(asDriver());

    expect(pickup.status).toBe(200);
    expect(pickup.body.documents).toHaveLength(1);
    expect(pickup.body.documents[0].kind).toBe('RELEASE_LETTER');

    const delivery = await api
      .get(`/api/consignments/${id}/documents?leg=DELIVERY`)
      .set(asDriver());

    expect(delivery.body.documents).toHaveLength(2);
  }, TIMEOUT);

  it('exposes no bare storage path, only expiring signed links', async () => {
    const id = await newOrder();
    await attach(id, 'release-letter', realPdf, 'letter.pdf').expect(200);

    const res = await api.get(`/api/consignments/${id}/documents`).set(asOperator());

    const [doc] = res.body.documents;
    // A signed url contains the object path by construction — that is what is
    // being signed. What must never appear is a bare path field a caller could
    // use to build their own request, as the DTOs deliberately omit.
    expect(doc).not.toHaveProperty('path');
    expect(doc).not.toHaveProperty('signaturePath');
    expect(doc.url).toContain('token=');
    expect(doc.url).toContain('/object/sign/');
  });
});

describe('signing a document at a stop', () => {
  it('stores the signature and builds a signed copy', async () => {
    const id = await newOrder();
    await attach(id, 'bill-of-lading', realPdf, 'bol.pdf').expect(200);
    await api
      .patch(`/api/consignments/${id}/documents/bill-of-lading`)
      .set(asOperator())
      .send({ signAtPickup: true })
      .expect(200);

    const res = await api
      .post(`/api/consignments/${id}/documents/bill-of-lading/sign/pickup`)
      .set(asOperator())
      .attach('signature', PNG_1X1, 'sig.png');

    expect(res.status).toBe(200);
    const [doc] = res.body.documents;
    expect(doc.signatures).toHaveLength(1);
    expect(doc.signatures[0].leg).toBe('PICKUP');
    expect(doc.signatures[0].signatureUrl).toContain('token=');
    // The original parses, so the stamped copy exists.
    expect(doc.signatures[0].signedUrl).toContain('token=');
  });

  it('keeps the signature when the original cannot be parsed', async () => {
    const id = await newOrder();
    // Passes the %PDF- sniffer, but pdf-lib cannot read it.
    await attach(id, 'release-letter', NOT_AN_IMAGE, 'broken.pdf').expect(200);
    await api
      .patch(`/api/consignments/${id}/documents/release-letter`)
      .set(asOperator())
      .send({ signAtPickup: true })
      .expect(200);

    const res = await api
      .post(`/api/consignments/${id}/documents/release-letter/sign/pickup`)
      .set(asOperator())
      .attach('signature', PNG_1X1, 'sig.png');

    expect(res.status).toBe(200);
    const sig = res.body.documents[0].signatures[0];
    expect(sig.signatureUrl).toContain('token=');
    // No stamped copy — and that must not have cost us the signature.
    expect(sig.signedUrl).toBeNull();
  });

  it('refuses a stop the document is not set to be signed at', async () => {
    const id = await newOrder();
    await attach(id, 'release-letter', realPdf, 'letter.pdf').expect(200);

    const res = await api
      .post(`/api/consignments/${id}/documents/release-letter/sign/delivery`)
      .set(asOperator())
      .attach('signature', PNG_1X1, 'sig.png');

    expect(res.status).toBe(409);
  });

  it('refuses a second signature for the same stop', async () => {
    const id = await newOrder();
    await attach(id, 'release-letter', realPdf, 'letter.pdf').expect(200);
    await api
      .patch(`/api/consignments/${id}/documents/release-letter`)
      .set(asOperator())
      .send({ signAtPickup: true })
      .expect(200);

    await api
      .post(`/api/consignments/${id}/documents/release-letter/sign/pickup`)
      .set(asOperator())
      .attach('signature', PNG_1X1, 'sig.png')
      .expect(200);

    const res = await api
      .post(`/api/consignments/${id}/documents/release-letter/sign/pickup`)
      .set(asOperator())
      .attach('signature', PNG_1X1, 'sig.png');

    expect(res.status).toBe(409);
  });

  it('refuses a signature that is not a PNG or JPEG', async () => {
    const id = await newOrder();
    await attach(id, 'release-letter', realPdf, 'letter.pdf').expect(200);
    await api
      .patch(`/api/consignments/${id}/documents/release-letter`)
      .set(asOperator())
      .send({ signAtPickup: true })
      .expect(200);

    const res = await api
      .post(`/api/consignments/${id}/documents/release-letter/sign/pickup`)
      .set(asOperator())
      .attach('signature', NOT_AN_IMAGE, 'sig.pdf');

    // Rejected by multer's content-type filter before the sniffer even runs.
    expect(res.status).toBe(400);
  });
});

describe('the paperwork gate blocks proof capture', () => {
  it('refuses pickup proof while a required signature is missing', async () => {
    const id = await orderAt('AT_PICKUP');
    await attach(id, 'bill-of-lading', realPdf, 'bol.pdf').expect(200);
    await api
      .patch(`/api/consignments/${id}/documents/bill-of-lading`)
      .set(asOperator())
      .send({ signAtPickup: true })
      .expect(200);

    const blocked = await capturePod(id, 'pickup');

    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toMatch(/bill of lading/i);

    // The order must not have moved, and no proof may exist.
    const after = await api.get(`/api/consignments/${id}`).set(asAdmin());
    expect(after.body.status).toBe('AT_PICKUP');
    expect(await prisma.proofOfDelivery.count({ where: { consignmentId: id } })).toBe(0);
  }, TIMEOUT);

  it('lets the proof through once the document is signed', async () => {
    const id = await orderAt('AT_PICKUP');
    await attach(id, 'bill-of-lading', realPdf, 'bol.pdf').expect(200);
    await api
      .patch(`/api/consignments/${id}/documents/bill-of-lading`)
      .set(asOperator())
      .send({ signAtPickup: true })
      .expect(200);

    await capturePod(id, 'pickup').expect(409);

    await api
      .post(`/api/consignments/${id}/documents/bill-of-lading/sign/pickup`)
      .set(asDriver())
      .attach('signature', PNG_1X1, 'sig.png')
      .expect(200);

    const res = await capturePod(id, 'pickup');

    expect(res.status).toBe(201);
    const after = await api.get(`/api/consignments/${id}`).set(asAdmin());
    expect(after.body.status).toBe('PICKED_UP');
  }, TIMEOUT);

  it('blocks the delivery leg independently of the pickup leg', async () => {
    const id = await orderAt('AT_DELIVERY');
    await attach(id, 'release-letter', realPdf, 'letter.pdf').expect(200);
    await api
      .patch(`/api/consignments/${id}/documents/release-letter`)
      .set(asOperator())
      .send({ signAtDelivery: true })
      .expect(200);

    const blocked = await capturePod(id, 'delivery');
    expect(blocked.status).toBe(409);

    // Signing the OTHER leg must not satisfy this one.
    await api
      .patch(`/api/consignments/${id}/documents/release-letter`)
      .set(asOperator())
      .send({ signAtPickup: true })
      .expect(200);
    await api
      .post(`/api/consignments/${id}/documents/release-letter/sign/pickup`)
      .set(asOperator())
      .attach('signature', PNG_1X1, 'sig.png')
      .expect(200);

    expect((await capturePod(id, 'delivery')).status).toBe(409);

    await api
      .post(`/api/consignments/${id}/documents/release-letter/sign/delivery`)
      .set(asOperator())
      .attach('signature', PNG_1X1, 'sig.png')
      .expect(200);

    expect((await capturePod(id, 'delivery')).status).toBe(201);
  }, TIMEOUT);

  it('does not block when the document is only shown, not signed', async () => {
    const id = await orderAt('AT_PICKUP');
    await attach(id, 'release-letter', realPdf, 'letter.pdf').expect(200);

    expect((await capturePod(id, 'pickup')).status).toBe(201);
  }, TIMEOUT);

  it('stops blocking once the operator clears the requirement', async () => {
    const id = await orderAt('AT_PICKUP');
    await attach(id, 'release-letter', realPdf, 'letter.pdf').expect(200);
    await api
      .patch(`/api/consignments/${id}/documents/release-letter`)
      .set(asOperator())
      .send({ signAtPickup: true })
      .expect(200);

    await capturePod(id, 'pickup').expect(409);

    // There is no waive path on the POD endpoint — clearing the flag on the
    // document is the only way through, and it is an operator action on record.
    await api
      .patch(`/api/consignments/${id}/documents/release-letter`)
      .set(asOperator())
      .send({ signAtPickup: false })
      .expect(200);

    expect((await capturePod(id, 'pickup')).status).toBe(201);
  }, TIMEOUT);
});

describe('who may do what', () => {
  it('lets the assigned driver read and sign, but not configure', async () => {
    const id = await newOrder();
    await attach(id, 'release-letter', realPdf, 'letter.pdf').expect(200);
    await api.post(`/api/consignments/${id}/assign`).set(asAdmin()).send({ driverId: ref.driverId });

    expect((await api.get(`/api/consignments/${id}/documents`).set(asDriver())).status).toBe(200);

    const configure = await api
      .patch(`/api/consignments/${id}/documents/release-letter`)
      .set(asDriver())
      .send({ signAtPickup: true });
    expect(configure.status).toBe(403);

    const upload = await api
      .post(`/api/consignments/${id}/documents/release-letter`)
      .set(asDriver())
      .attach('file', realPdf, 'x.pdf');
    expect(upload.status).toBe(403);
  }, TIMEOUT);

  it('refuses a driver the order is not assigned to', async () => {
    const id = await newOrder();
    await api.post(`/api/consignments/${id}/assign`).set(asAdmin()).send({ driverId: ref.driverBId });

    const res = await api.get(`/api/consignments/${id}/documents`).set(asDriver());

    expect(res.status).toBe(403);
  });

  it('requires a token', async () => {
    const id = await newOrder();

    expect((await api.get(`/api/consignments/${id}/documents`)).status).toBe(401);
  });
});

describe('the deprecated release-letter endpoints', () => {
  it('still serve the new table, so the deployed driver build keeps working', async () => {
    const id = await newOrder();

    const empty = await api.get(`/api/consignments/${id}/release-letter`).set(asOperator());
    expect(empty.status).toBe(200);
    expect(empty.body.hasReleaseLetter).toBe(false);
    expect(empty.body.releaseLetterUrl).toBeNull();

    await api
      .post(`/api/consignments/${id}/release-letter`)
      .set(asOperator())
      .attach('file', realPdf, 'letter.pdf')
      .expect(200);

    const filled = await api.get(`/api/consignments/${id}/release-letter`).set(asOperator());
    expect(filled.body.hasReleaseLetter).toBe(true);
    expect(filled.body.releaseLetterUrl).toContain('token=');

    // And the new endpoint sees the same row.
    const viaNew = await api.get(`/api/consignments/${id}/documents`).set(asOperator());
    expect(viaNew.body.documents).toHaveLength(1);
    expect(viaNew.body.documents[0].kind).toBe('RELEASE_LETTER');

    const removed = await api.delete(`/api/consignments/${id}/release-letter`).set(asOperator());
    expect(removed.status).toBe(200);
    expect(removed.body.hasReleaseLetter).toBe(false);
  }, TIMEOUT);

  it('reports hasReleaseLetter on the order detail and the grid', async () => {
    const id = await newOrder();
    await attach(id, 'release-letter', realPdf, 'letter.pdf').expect(200);

    const detail = await api.get(`/api/consignments/${id}`).set(asOperator());
    expect(detail.body.hasReleaseLetter).toBe(true);

    const grid = await api.get(`/api/consignments?pageSize=100`).set(asOperator());
    const row = grid.body.data.find((r: { id: string }) => r.id === id);
    expect(row.hasReleaseLetter).toBe(true);
  });
});
