import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api,
  authHeader,
  cleanConsignments,
  getToken,
  seedReference,
  type Reference,
} from './helpers/api.js';
import { buildConsignment } from './helpers/factory.js';

let ref: Reference;
let token: string;

beforeAll(async () => {
  ref = await seedReference();
  token = await getToken();
});

beforeEach(async () => {
  await cleanConsignments();
});

describe('order number allocation', () => {
  it('mints a distinct number for every concurrent create', async () => {
    const N = 20;

    const results = await Promise.all(
      Array.from({ length: N }, () =>
        api
          .post('/api/consignments')
          .set(authHeader(token))
          .send(buildConsignment(ref.clientId)),
      ),
    );

    // The old read-max-then-increment approach failed exactly here: several
    // requests read the same maximum and collided on the unique index.
    expect(results.every((r) => r.status === 201)).toBe(true);

    const numbers = results.map((r) => r.body.orderNo as string);
    expect(new Set(numbers).size).toBe(N);
  });

  it('sequences per client rather than globally', async () => {
    const a = await api
      .post('/api/consignments')
      .set(authHeader(token))
      .send(buildConsignment(ref.clientId));
    const b = await api
      .post('/api/consignments')
      .set(authHeader(token))
      .send(buildConsignment(ref.otherClientId));

    expect(a.body.orderNo).toMatch(new RegExp(`^${ref.clientCode}-\\d{8}-0001$`));
    expect(b.body.orderNo).toMatch(new RegExp(`^${ref.otherClientCode}-\\d{8}-0001$`));
  });

  it('increments within a client', async () => {
    const first = await api
      .post('/api/consignments')
      .set(authHeader(token))
      .send(buildConsignment(ref.clientId));
    const second = await api
      .post('/api/consignments')
      .set(authHeader(token))
      .send(buildConsignment(ref.clientId));

    expect(first.body.orderNo.endsWith('-0001')).toBe(true);
    expect(second.body.orderNo.endsWith('-0002')).toBe(true);
  });
});
