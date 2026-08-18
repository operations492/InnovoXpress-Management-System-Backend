import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api,
  authHeader,
  cleanConsignments,
  getDriverToken,
  getToken,
  prisma,
  seedReference,
  type Reference,
} from './helpers/api.js';

let ref: Reference;
let token: string;
let driverToken: string;
let driverBToken: string;

// A short route through Lahore.
const ROUTE = [
  { lat: 31.5204, lng: 74.3587, accuracyM: 12, speedMps: 8.3, headingDeg: 90 },
  { lat: 31.521, lng: 74.3601, accuracyM: 10, speedMps: 9.1, headingDeg: 88 },
  { lat: 31.5218, lng: 74.3625, accuracyM: 8, speedMps: 7.6, headingDeg: 85 },
];

beforeAll(async () => {
  ref = await seedReference();
  token = await getToken();
  driverToken = await getDriverToken(ref.driverId);
  driverBToken = await getDriverToken(ref.driverBId);
});

beforeEach(async () => {
  await cleanConsignments();
});

const auth = () => authHeader(token);
const asDriver = () => authHeader(driverToken);
const asDriverB = () => authHeader(driverBToken);

const post = (t: Record<string, string>, pings: unknown[]) =>
  api.post('/api/drivers/me/locations').set(t).send({ pings });

describe('recording pings', () => {
  it('accepts a batch — a phone buffers offline and flushes on reconnect', async () => {
    const res = await post(asDriver(), ROUTE);
    expect(res.status).toBe(201);
    expect(res.body.accepted).toBe(3);
  });

  it('stores the ping against the driver in the token', async () => {
    await post(asDriver(), [{ lat: 31.52, lng: 74.35 }]);

    const mine = await prisma.driverLocation.count({ where: { driverId: ref.driverId } });
    const theirs = await prisma.driverLocation.count({ where: { driverId: ref.driverBId } });
    expect(mine).toBe(1);
    expect(theirs).toBe(0);
  });

  it('refuses a body that tries to name a different driver', async () => {
    // The schema is strict, so an attempt to smuggle a driverId is a 400 rather
    // than a silently ignored field.
    const res = await post(asDriver(), [
      { lat: 31.52, lng: 74.35, driverId: ref.driverBId },
    ]);
    expect(res.status).toBe(400);
    expect(await prisma.driverLocation.count()).toBe(0);
  });

  it('keeps a batch in order, so the newest point is genuinely the last one', async () => {
    await post(asDriver(), ROUTE);

    const rows = await prisma.driverLocation.findMany({
      where: { driverId: ref.driverId },
      orderBy: { recordedAt: 'asc' },
    });

    // Distinct timestamps: identical ones would make "latest position" arbitrary.
    const times = rows.map((r) => r.recordedAt.getTime());
    expect(new Set(times).size).toBe(3);
    expect(rows[2].lat).toBeCloseTo(31.5218, 4);
  });

  it('rejects an impossible latitude', async () => {
    const res = await post(asDriver(), [{ lat: 999, lng: 74 }]);
    expect(res.status).toBe(400);
  });

  it('rejects an impossible longitude', async () => {
    const res = await post(asDriver(), [{ lat: 31, lng: 500 }]);
    expect(res.status).toBe(400);
  });

  it('rejects an empty batch', async () => {
    const res = await post(asDriver(), []);
    expect(res.status).toBe(400);
  });

  it('refuses a device clock set to the future', async () => {
    const future = new Date(Date.now() + 60 * 60_000);
    await post(asDriver(), [{ lat: 31.52, lng: 74.35, recordedAt: future.toISOString() }]);

    const row = await prisma.driverLocation.findFirst({ where: { driverId: ref.driverId } });
    // Clamped to now — a forward-set phone clock must not park a ping in the
    // future where retention will never reach it.
    expect(row!.recordedAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('keeps a past timestamp, so a buffered ping stays truthful', async () => {
    const earlier = new Date(Date.now() - 10 * 60_000);
    await post(asDriver(), [{ lat: 31.52, lng: 74.35, recordedAt: earlier.toISOString() }]);

    const row = await prisma.driverLocation.findFirst({ where: { driverId: ref.driverId } });
    expect(Math.abs(row!.recordedAt.getTime() - earlier.getTime())).toBeLessThan(2000);
  });

  it('needs a driver token — an operator has no position to report', async () => {
    const res = await post(auth(), ROUTE);
    expect(res.status).toBe(403);
  });

  it('needs a token at all', async () => {
    const res = await api.post('/api/drivers/me/locations').send({ pings: ROUTE });
    expect(res.status).toBe(401);
  });
});

describe('the live map', () => {
  it('returns one row per driver, the most recent', async () => {
    await post(asDriver(), ROUTE);
    await post(asDriverB(), [{ lat: 24.8607, lng: 67.0011 }]);

    // The live map shows drivers who are clocked ON and reporting. Seeded
    // drivers start off shift, so without this they are correctly excluded.
    await prisma.driver.updateMany({
      where: { id: { in: [ref.driverId, ref.driverBId] } },
      data: { onShift: true },
    });

    const res = await api.get('/api/drivers/locations/latest').set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);

    const mine = res.body.data.find((d: { driverId: string }) => d.driverId === ref.driverId);
    // The last point of the route, not the first.
    expect(mine.lat).toBeCloseTo(31.5218, 4);
    expect(mine.name).toBeTruthy();
  });

  it('ignores drivers who have not reported recently', async () => {
    // The live map reads driver_positions, so the stale row has to be there — a
    // stale history row would prove nothing, since the map never looks at history.
    await prisma.driverPosition.create({
      data: {
        driverId: ref.driverId,
        lat: 31.5,
        lng: 74.3,
        recordedAt: new Date(Date.now() - 3 * 60 * 60_000), // 3 hours ago
      },
    });

    const res = await api.get('/api/drivers/locations/latest').set(auth());
    expect(res.body.data).toHaveLength(0);
  });

  it('keeps a stationary driver visible — the bug this table exists for', async () => {
    await prisma.driver.update({ where: { id: ref.driverId }, data: { onShift: true } });

    // Same coordinate twice, which is what a parked phone reports. The second batch
    // adds nothing to history and must still refresh the position.
    await post(asDriver(), [{ lat: 31.52, lng: 74.35 }]);
    const second = await post(asDriver(), [{ lat: 31.52, lng: 74.35 }]);

    expect(second.body.accepted).toBe(0); // nothing worth keeping as history
    const res = await api.get('/api/drivers/locations/latest').set(auth());
    expect(res.body.data.some((d: { driverId: string }) => d.driverId === ref.driverId)).toBe(true);
  });

  it('is operator-only', async () => {
    const res = await api.get('/api/drivers/locations/latest').set(asDriver());
    expect(res.status).toBe(403);
  });
});

describe('the trail', () => {
  it('returns the points oldest first, ready to draw as a line', async () => {
    await post(asDriver(), ROUTE);

    const res = await api.get(`/api/drivers/${ref.driverId}/trail`).set(auth());

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(3);
    expect(res.body.data[0].lat).toBeCloseTo(31.5204, 4);
    expect(res.body.data[2].lat).toBeCloseTo(31.5218, 4);

    const times = res.body.data.map((p: { recordedAt: string }) => new Date(p.recordedAt).getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('reports the retention window so the UI can say how far back it goes', async () => {
    await post(asDriver(), ROUTE);
    const res = await api.get(`/api/drivers/${ref.driverId}/trail`).set(auth());
    expect(res.body.retentionDays).toBeGreaterThan(0);
  });

  it('returns only that driver’s points', async () => {
    await post(asDriver(), ROUTE);
    await post(asDriverB(), [{ lat: 24.8607, lng: 67.0011 }]);

    const res = await api.get(`/api/drivers/${ref.driverId}/trail`).set(auth());
    expect(res.body.count).toBe(3);
  });

  it('honours a time window', async () => {
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    await prisma.driverLocation.create({
      data: { driverId: ref.driverId, lat: 31.4, lng: 74.2, recordedAt: old },
    });
    await post(asDriver(), ROUTE);

    const res = await api
      .get(`/api/drivers/${ref.driverId}/trail`)
      .query({ from: new Date(Date.now() - 30 * 60_000).toISOString() })
      .set(auth());

    expect(res.body.count).toBe(3);
  });

  it('caps the number of points returned', async () => {
    await post(asDriver(), ROUTE);
    const res = await api
      .get(`/api/drivers/${ref.driverId}/trail`)
      .query({ limit: 2 })
      .set(auth());

    expect(res.body.count).toBe(2);
  });

  it('404s for an unknown driver', async () => {
    const res = await api.get('/api/drivers/drv_nope/trail').set(auth());
    expect(res.status).toBe(404);
  });

  it('is operator-only', async () => {
    const res = await api.get(`/api/drivers/${ref.driverId}/trail`).set(asDriver());
    expect(res.status).toBe(403);
  });
});
