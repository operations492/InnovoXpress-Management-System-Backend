import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
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

/*
 * The dispatch change feed.
 *
 * The load-bearing test here is the payload SHAPE. Realtime computes channel
 * authorization when a client joins and caches it for the life of the
 * connection, so nobody can be promptly revoked from a shared topic — which
 * means the payload must never carry anything worth stealing. A comment in
 * map.sql says so; this file is what actually enforces it.
 */

interface FeedRow {
  topic: string;
  event: string;
  private: boolean;
  extension: string;
  payload: Record<string, unknown>;
}

let ref: Reference;
let token: string;

function feed(): Promise<FeedRow[]> {
  return prisma.$queryRawUnsafe<FeedRow[]>(
    `select topic, event, private, extension, payload
       from realtime.messages
      where topic = 'dispatch:tasks'
      order by inserted_at`,
  );
}

const clearFeed = () =>
  prisma.$executeRawUnsafe(`delete from realtime.messages where topic = 'dispatch:tasks'`);

beforeAll(async () => {
  ref = await seedReference();
  token = await getToken();

  const [{ partitions }] = await prisma.$queryRawUnsafe<{ partitions: bigint }[]>(
    `select count(*) as partitions
       from pg_inherits i
       join pg_class p on p.oid = i.inhparent
       join pg_namespace n on n.oid = p.relnamespace
      where n.nspname = 'realtime' and p.relname = 'messages'`,
  );
  if (Number(partitions) === 0) {
    throw new Error(
      'realtime.messages has no partitions — broadcasts are silently dropped. ' +
        'Connect a Realtime client to the project once so the tenant provisions them.',
    );
  }
});

beforeEach(async () => {
  await cleanConsignments();
  await clearFeed();
});

const auth = () => authHeader(token);

async function create(): Promise<string> {
  const res = await api.post('/api/consignments').set(auth()).send(buildConsignment(ref.clientId));
  expect(res.status).toBe(201);
  return res.body.id as string;
}

/* ------------------------------------------------------------------ */

describe('the payload is an invalidation and nothing more', () => {
  it('carries exactly id and op', async () => {
    // If this ever grows a field, read the warning at the top of map.sql before
    // changing the assertion.
    await create();

    const rows = await feed();
    expect(rows.length).toBeGreaterThan(0);
    expect(Object.keys(rows[0].payload).sort()).toEqual(['id', 'op']);
  });

  it('names no customer, address or driver anywhere in the feed', async () => {
    const id = await create();
    await api.post(`/api/consignments/${id}/assign`).set(auth()).send({ driverId: ref.driverId });

    const body = JSON.stringify(await feed());
    for (const leak of ['Sana', 'Yousaf', 'Lahore', 'House', 'Warehouse', 'receiver', 'sender']) {
      expect(body).not.toContain(leak);
    }
  });

  it('is broadcast privately on the dispatch topic', async () => {
    await create();

    const [row] = await feed();
    expect(row.topic).toBe('dispatch:tasks');
    expect(row.event).toBe('map.task.changed');
    expect(row.private).toBe(true);
    expect(row.extension).toBe('broadcast');
  });
});

describe('what triggers a change', () => {
  it('a new task', async () => {
    const id = await create();

    const upserts = (await feed()).filter((r) => r.payload.op === 'upsert');
    expect(upserts.some((r) => r.payload.id === id)).toBe(true);
  });

  it('an assignment', async () => {
    const id = await create();
    await clearFeed();

    await api.post(`/api/consignments/${id}/assign`).set(auth()).send({ driverId: ref.driverId });

    const rows = await feed();
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toEqual({ id, op: 'upsert' });
  });

  it('a status change', async () => {
    const id = await create();
    await api.post(`/api/consignments/${id}/assign`).set(auth()).send({ driverId: ref.driverId });
    await clearFeed();

    await api
      .patch(`/api/consignments/${id}/status`)
      .set(auth())
      .send({ status: 'EN_ROUTE_TO_PICKUP' });

    expect(await feed()).toHaveLength(1);
  });

  it('a moved pin — the case a column-list trigger would have missed', async () => {
    const id = await create();
    await clearFeed();

    await prisma.consignment.update({
      where: { id },
      data: { receiverLat: 31.9, receiverLng: 74.9 },
    });

    const rows = await feed();
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toEqual({ id, op: 'upsert' });
  });

  it('an item edit, keyed to the parent task', async () => {
    const id = await create();
    await clearFeed();

    await prisma.item.create({
      data: { consignmentId: id, description: 'Extra carton', qty: 4 },
    });

    const rows = await feed();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.payload.id === id)).toBe(true);
    expect(rows[0].payload.op).toBe('upsert');
  });

  it('a deletion, reported as a delete', async () => {
    const id = await create();
    await clearFeed();

    await prisma.consignment.delete({ where: { id } });

    const rows = await feed();
    // Items cascade first and report an upsert on a task that is about to go;
    // what matters is that a delete is present for it.
    expect(rows.some((r) => r.payload.id === id && r.payload.op === 'delete')).toBe(true);
  });

  it('says nothing when an update changes nothing', async () => {
    const id = await create();
    await clearFeed();

    await prisma.consignment.updateMany({
      where: { id },
      data: { priority: 'NORMAL' },
    });

    // The guard compares the rows with `updatedAt` removed. Without that
    // exclusion this test fails: Prisma's @updatedAt changes on every write, so
    // a plain OLD.* IS DISTINCT FROM NEW.* would never suppress anything.
    expect(await feed()).toHaveLength(0);
  });
});

describe('who may listen', () => {
  it('gates the topic on being an operator, not on a JWT claim', async () => {
    const rows = await prisma.$queryRawUnsafe<{ policyname: string; qual: string }[]>(
      `select policyname, qual from pg_policies
        where schemaname = 'realtime' and tablename = 'messages'
          and policyname = 'dispatch tasks read'`,
    );

    expect(rows).toHaveLength(1);
    // Reads public.users, not app_metadata — a demoted operator keeps a stale
    // claim until their token refreshes.
    expect(rows[0].qual).toContain('is_ops_user');
    expect(rows[0].qual).not.toContain('app_metadata');
  });

  it('answers false for a driver and true for an operator', async () => {
    const driverUser = await prisma.user.findFirst({
      where: { driverId: ref.driverId },
      select: { id: true },
    });
    const operator = await prisma.user.findFirst({
      where: { role: { in: ['operator', 'admin'] }, active: true },
      select: { id: true },
    });

    const check = (userId: string) =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `select set_config('request.jwt.claims', $1, true)`,
          JSON.stringify({ sub: userId, role: 'authenticated' }),
        );
        const [row] = await tx.$queryRawUnsafe<{ ok: boolean }[]>(
          `select public.is_ops_user() as ok`,
        );
        return row.ok;
      });

    expect(await check(driverUser!.id)).toBe(false);
    expect(await check(operator!.id)).toBe(true);
  });
});
