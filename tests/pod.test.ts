import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
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
import { JPEG_1X1, NOT_AN_IMAGE, PNG_1X1, oversizedPng } from './helpers/files.js';
import { supabase, POD_BUCKET } from '../src/config/supabase.js';

let ref: Reference;
let token: string;
const createdIds: string[] = [];

beforeAll(async () => {
  ref = await seedReference();
  token = await getToken();
});

beforeEach(async () => {
  await cleanConsignments();
});

afterAll(async () => {
  // Storage is not transactional, so objects written by the suite have to be
  // swept explicitly or they accumulate in the real bucket.
  const paths = createdIds.flatMap((id) => [
    `${id}/PICKUP/photo.png`,
    `${id}/PICKUP/signature.png`,
    `${id}/PICKUP/photo.jpg`,
    `${id}/PICKUP/signature.jpg`,
    `${id}/DELIVERY/photo.png`,
    `${id}/DELIVERY/signature.png`,
  ]);
  if (paths.length) await supabase.storage.from(POD_BUCKET).remove(paths);
});

const auth = () => authHeader(token);

/** Drive an order up to the point where a given leg's proof can be captured. */
async function orderAt(status: 'AT_PICKUP' | 'AT_DELIVERY' | 'ASSIGNED') {
  const created = await api
    .post('/api/consignments')
    .set(auth())
    .send(buildConsignment(ref.clientId));
  const id = created.body.id as string;
  createdIds.push(id);

  await api.post(`/api/consignments/${id}/assign`).set(auth()).send({ driverId: ref.driverId });
  if (status === 'ASSIGNED') return id;

  await api.patch(`/api/consignments/${id}/status`).set(auth()).send({ status: 'EN_ROUTE_TO_PICKUP' });
  await api.patch(`/api/consignments/${id}/status`).set(auth()).send({ status: 'AT_PICKUP' });
  if (status === 'AT_PICKUP') return id;

  await api
    .post(`/api/consignments/${id}/pod/pickup`)
    .set(auth())
    .attach('photo', PNG_1X1, 'photo.png')
    .attach('signature', PNG_1X1, 'signature.png');
  await api
    .patch(`/api/consignments/${id}/status`)
    .set(auth())
    .send({ status: 'EN_ROUTE_TO_DELIVERY' });
  await api.patch(`/api/consignments/${id}/status`).set(auth()).send({ status: 'AT_DELIVERY' });
  return id;
}

describe('capturing pickup proof', () => {
  it('stores both files and moves the order to picked up', async () => {
    const id = await orderAt('AT_PICKUP');

    const res = await api
      .post(`/api/consignments/${id}/pod/pickup`)
      .set(auth())
      .attach('photo', PNG_1X1, 'photo.png')
      .attach('signature', PNG_1X1, 'sig.png');

    expect(res.status).toBe(201);
    expect(res.body.proof).toHaveLength(1);
    expect(res.body.proof[0].leg).toBe('PICKUP');

    const after = await api.get(`/api/consignments/${id}`).set(auth());
    expect(after.body.status).toBe('PICKED_UP');
    expect(after.body.pickedUpAt).not.toBeNull();
  });

  it('returns working, time-limited links to the stored images', async () => {
    const id = await orderAt('AT_PICKUP');
    await api
      .post(`/api/consignments/${id}/pod/pickup`)
      .set(auth())
      .attach('photo', JPEG_1X1, 'photo.jpg')
      .attach('signature', JPEG_1X1, 'sig.jpg');

    const res = await api.get(`/api/consignments/${id}/pod`).set(auth());
    const proof = res.body.proof[0];

    expect(proof.photo.url).toContain('token=');
    expect(proof.signature.url).toContain('token=');
    expect(proof.expiresInSeconds).toBeGreaterThan(0);

    // The link must actually resolve to the bytes we uploaded.
    const fetched = await fetch(proof.photo.url);
    expect(fetched.status).toBe(200);
    expect(Buffer.from(await fetched.arrayBuffer()).length).toBe(JPEG_1X1.length);
  });

  it('records the capture in the timeline', async () => {
    const id = await orderAt('AT_PICKUP');
    await api
      .post(`/api/consignments/${id}/pod/pickup`)
      .set(auth())
      .attach('photo', PNG_1X1, 'photo.png')
      .attach('signature', PNG_1X1, 'sig.png');

    const after = await api.get(`/api/consignments/${id}`).set(auth());
    expect(after.body.timeline[0].fromStatus).toBe('AT_PICKUP');
    expect(after.body.timeline[0].toStatus).toBe('PICKED_UP');
  });

  it('refuses when the order has not reached the pickup point', async () => {
    const id = await orderAt('ASSIGNED');

    const res = await api
      .post(`/api/consignments/${id}/pod/pickup`)
      .set(auth())
      .attach('photo', PNG_1X1, 'photo.png')
      .attach('signature', PNG_1X1, 'sig.png');

    expect(res.status).toBe(409);
  });

  it('refuses a second capture for the same leg', async () => {
    const id = await orderAt('AT_PICKUP');
    await api
      .post(`/api/consignments/${id}/pod/pickup`)
      .set(auth())
      .attach('photo', PNG_1X1, 'photo.png')
      .attach('signature', PNG_1X1, 'sig.png');

    const res = await api
      .post(`/api/consignments/${id}/pod/pickup`)
      .set(auth())
      .attach('photo', PNG_1X1, 'photo.png')
      .attach('signature', PNG_1X1, 'sig.png');

    expect(res.status).toBe(409);
  });
});

describe('rejecting bad uploads', () => {
  it('requires the photo', async () => {
    const id = await orderAt('AT_PICKUP');
    const res = await api
      .post(`/api/consignments/${id}/pod/pickup`)
      .set(auth())
      .attach('signature', PNG_1X1, 'sig.png');

    expect(res.status).toBe(400);
  });

  it('requires the signature', async () => {
    const id = await orderAt('AT_PICKUP');
    const res = await api
      .post(`/api/consignments/${id}/pod/pickup`)
      .set(auth())
      .attach('photo', PNG_1X1, 'photo.png');

    expect(res.status).toBe(400);
  });

  it('rejects a non-image even when it claims to be a PNG', async () => {
    const id = await orderAt('AT_PICKUP');

    // Declared Content-Type is image/png; the bytes are a PDF. Only a magic-byte
    // check catches this — trusting the header would store an arbitrary file.
    const res = await api
      .post(`/api/consignments/${id}/pod/pickup`)
      .set(auth())
      .attach('photo', NOT_AN_IMAGE, { filename: 'evil.png', contentType: 'image/png' })
      .attach('signature', PNG_1X1, 'sig.png');

    expect(res.status).toBe(400);

    const after = await api.get(`/api/consignments/${id}`).set(auth());
    expect(after.body.status).toBe('AT_PICKUP');
  });

  it('rejects a signature over its size limit', async () => {
    const id = await orderAt('AT_PICKUP');
    const big = oversizedPng(2_097_153); // 1 byte past POD_MAX_SIGNATURE_BYTES

    const res = await api
      .post(`/api/consignments/${id}/pod/pickup`)
      .set(auth())
      .attach('photo', PNG_1X1, 'photo.png')
      .attach('signature', big, 'sig.png');

    expect(res.status).toBe(413);
  });

  it('leaves the status untouched when a capture fails', async () => {
    const id = await orderAt('AT_PICKUP');
    await api
      .post(`/api/consignments/${id}/pod/pickup`)
      .set(auth())
      .attach('photo', NOT_AN_IMAGE, { filename: 'x.png', contentType: 'image/png' })
      .attach('signature', PNG_1X1, 'sig.png');

    const after = await api.get(`/api/consignments/${id}`).set(auth());
    expect(after.body.status).toBe('AT_PICKUP');
    expect(after.body.proofs).toEqual([]);
  });

  it('requires a token', async () => {
    const id = await orderAt('AT_PICKUP');
    const res = await api
      .post(`/api/consignments/${id}/pod/pickup`)
      .attach('photo', PNG_1X1, 'photo.png')
      .attach('signature', PNG_1X1, 'sig.png');

    expect(res.status).toBe(401);
  });
});

describe('idempotency', () => {
  it('replays a retry with the same key instead of reporting a conflict', async () => {
    const id = await orderAt('AT_PICKUP');
    const key = 'retry-key-0001';

    const first = await api
      .post(`/api/consignments/${id}/pod/pickup`)
      .set(auth())
      .set('Idempotency-Key', key)
      .attach('photo', PNG_1X1, 'photo.png')
      .attach('signature', PNG_1X1, 'sig.png');

    // Exactly what a phone does when the response is lost on a weak connection.
    const retry = await api
      .post(`/api/consignments/${id}/pod/pickup`)
      .set(auth())
      .set('Idempotency-Key', key)
      .attach('photo', PNG_1X1, 'photo.png')
      .attach('signature', PNG_1X1, 'sig.png');

    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.body.proof[0].capturedAt).toBe(first.body.proof[0].capturedAt);

    const count = await prisma.proofOfDelivery.count({ where: { consignmentId: id } });
    expect(count).toBe(1);
  });

  it('still conflicts for a different key', async () => {
    const id = await orderAt('AT_PICKUP');
    await api
      .post(`/api/consignments/${id}/pod/pickup`)
      .set(auth())
      .set('Idempotency-Key', 'key-a')
      .attach('photo', PNG_1X1, 'photo.png')
      .attach('signature', PNG_1X1, 'sig.png');

    const res = await api
      .post(`/api/consignments/${id}/pod/pickup`)
      .set(auth())
      .set('Idempotency-Key', 'key-b')
      .attach('photo', PNG_1X1, 'photo.png')
      .attach('signature', PNG_1X1, 'sig.png');

    expect(res.status).toBe(409);
  });
});

describe('capturing delivery proof', () => {
  it('completes the job and marks it delivered', async () => {
    const id = await orderAt('AT_DELIVERY');

    const res = await api
      .post(`/api/consignments/${id}/pod/delivery`)
      .set(auth())
      .attach('photo', PNG_1X1, 'photo.png')
      .attach('signature', PNG_1X1, 'sig.png');

    expect(res.status).toBe(201);

    const after = await api.get(`/api/consignments/${id}`).set(auth());
    expect(after.body.status).toBe('DELIVERED');
    expect(after.body.deliveredAt).not.toBeNull();
    expect(after.body.proofs).toHaveLength(2);
  });

  it('refuses delivery proof while the order is only at pickup', async () => {
    const id = await orderAt('AT_PICKUP');

    const res = await api
      .post(`/api/consignments/${id}/pod/delivery`)
      .set(auth())
      .attach('photo', PNG_1X1, 'photo.png')
      .attach('signature', PNG_1X1, 'sig.png');

    expect(res.status).toBe(409);
  });
});

describe('proof is the only route to picked up or delivered', () => {
  it('rejects a manual status change to PICKED_UP', async () => {
    const id = await orderAt('AT_PICKUP');
    const res = await api
      .patch(`/api/consignments/${id}/status`)
      .set(auth())
      .send({ status: 'PICKED_UP' });

    expect(res.status).toBe(400);
  });

  it('rejects a manual status change to DELIVERED', async () => {
    const id = await orderAt('AT_DELIVERY');
    const res = await api
      .patch(`/api/consignments/${id}/status`)
      .set(auth())
      .send({ status: 'DELIVERED' });

    expect(res.status).toBe(400);

    const after = await api.get(`/api/consignments/${id}`).set(auth());
    expect(after.body.status).toBe('AT_DELIVERY');
  });

  it('never leaves a delivered order without proof', async () => {
    const id = await orderAt('AT_DELIVERY');
    await api
      .post(`/api/consignments/${id}/pod/delivery`)
      .set(auth())
      .attach('photo', PNG_1X1, 'photo.png')
      .attach('signature', PNG_1X1, 'sig.png');

    const orphans = await prisma.consignment.findMany({
      where: {
        status: 'DELIVERED',
        proofs: { none: { leg: 'DELIVERY' } },
      },
      select: { id: true },
    });

    expect(orphans).toEqual([]);
  });
});
