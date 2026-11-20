import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TEST_DOMAIN, api, authHeader, ensureConsoleUser, getToken, prisma, seedReference, type Reference } from './helpers/api.js';
import { resolveZone } from '../src/modules/zones/zones.service.js';

/*
 * Zone lists, the postal codes inside them, and the rate cards priced over them.
 *
 * Self-cleaning on purpose: this suite creates its own zone lists and rate cards
 * and deletes exactly those ids at the end. It never truncates, because it runs
 * against the shared project — see the warning in CLAUDE.md.
 */

const TIMEOUT = 120_000;

let ref: Reference;
let admin: string;
let operator: string;
let serviceLevelId: string;
let freightItemId: string;

/** Everything this file made, torn down in reverse dependency order. */
const cardIds: string[] = [];
const listIds: string[] = [];
const serviceIds: string[] = [];

beforeAll(async () => {
  ref = await seedReference();
  admin = await getToken();
  operator = (
    await ensureConsoleUser({ email: `ops-rates@${TEST_DOMAIN}`, name: 'Ops RATES', role: 'operator' })
  ).token;

  const [sl, fi] = await Promise.all([
    prisma.serviceLevel.findFirst({ where: { active: true }, select: { id: true } }),
    prisma.freightItem.findFirst({ where: { active: true }, select: { id: true } }),
  ]);
  if (!sl || !fi) throw new Error('Seed the service level and freight item catalogues first');
  serviceLevelId = sl.id;
  freightItemId = fi.id;
});

afterAll(async () => {
  // Cards first: they hold a Restrict reference to the zone list, and their
  // service overrides cascade away with them before the catalogue rows go.
  if (cardIds.length) await prisma.rateCard.deleteMany({ where: { id: { in: cardIds } } });
  if (serviceIds.length) {
    await prisma.additionalService.deleteMany({ where: { id: { in: serviceIds } } });
  }
  if (listIds.length) await prisma.zoneList.deleteMany({ where: { id: { in: listIds } } });
});

const asAdmin = () => authHeader(admin);
const asOperator = () => authHeader(operator);

let seq = 0;
const unique = (what: string) => `ZT-${Date.now()}-${seq++}-${what}`;

async function newList(): Promise<string> {
  const res = await api.post('/api/zone-lists').set(asAdmin()).send({ name: unique('list') });
  if (res.status !== 201) throw new Error(`list failed: ${res.status} ${JSON.stringify(res.body)}`);
  listIds.push(res.body.id);
  return res.body.id;
}

async function newZone(listId: string, name: string): Promise<string> {
  const res = await api.post(`/api/zone-lists/${listId}/zones`).set(asAdmin()).send({ name });
  if (res.status !== 201) throw new Error(`zone failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.id;
}

const putCodes = (listId: string, zoneId: string, text: string) =>
  api.put(`/api/zone-lists/${listId}/zones/${zoneId}/codes`).set(asAdmin()).send({ text });

const previewCodes = (listId: string, zoneId: string, text: string) =>
  api.post(`/api/zone-lists/${listId}/zones/${zoneId}/codes/preview`).set(asAdmin()).send({ text });

async function newCard(zoneListId: string, from: string, to: string): Promise<string> {
  const res = await api.post('/api/rate-cards').set(asAdmin()).send({
    name: unique('card'),
    clientId: ref.clientId,
    zoneListId,
    validFrom: from,
    validTo: to,
  });
  if (res.status !== 201) throw new Error(`card failed: ${res.status} ${JSON.stringify(res.body)}`);
  cardIds.push(res.body.id);
  return res.body.id;
}

describe('postal codes', () => {
  it('sorts a pasted list into valid, duplicate and invalid', async () => {
    const list = await newList();
    const zone = await newZone(list, 'Toronto');

    const res = await previewCodes(list, zone, 'K1A, L6T, 0M2, v7b.v5j, L6T');

    expect(res.status).toBe(200);
    expect(res.body.valid.map((c: { code: string }) => c.code)).toEqual(['K1A', 'L6T']);
    expect(res.body.duplicates).toEqual(['L6T']);
    expect(res.body.invalid).toEqual(['0M2', 'v7b.v5j']);
  }, TIMEOUT);

  it('keeps a full code whole instead of splitting it on the space', async () => {
    const list = await newList();
    const zone = await newZone(list, 'Calgary');

    const res = await putCodes(list, zone, 'T2E 6W5');

    expect(res.status).toBe(200);
    expect(res.body.codes).toHaveLength(1);
    expect(res.body.codes[0]).toMatchObject({ code: 'T2E6W5', codeType: 'FULL' });
  }, TIMEOUT);

  it('refuses to save a code that another zone in the list already holds', async () => {
    const list = await newList();
    const brampton = await newZone(list, 'Brampton');
    const toronto = await newZone(list, 'Toronto');

    await putCodes(list, brampton, 'L6T').expect(200);
    const res = await putCodes(list, toronto, 'L6T');

    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('Brampton');

    // Nothing was written: the whole paste is rejected, not the half that fit.
    const after = await api.get(`/api/zone-lists/${list}/zones/${toronto}`).set(asOperator());
    expect(after.body.codes).toHaveLength(0);
  }, TIMEOUT);

  it('lets the same code live in two different zone lists', async () => {
    const a = await newList();
    const b = await newList();
    const za = await newZone(a, 'Toronto');
    const zb = await newZone(b, 'Toronto');

    await putCodes(a, za, 'M5V').expect(200);
    await putCodes(b, zb, 'M5V').expect(200);
  }, TIMEOUT);

  it('replaces the typed set rather than appending to it', async () => {
    const list = await newList();
    const zone = await newZone(list, 'Timmins');

    await putCodes(list, zone, 'P4N, P4P').expect(200);
    const res = await putCodes(list, zone, 'P4N');

    expect(res.body.codes.map((c: { code: string }) => c.code)).toEqual(['P4N']);
  }, TIMEOUT);
});

describe('the drawn shape', () => {
  const SQUARE = {
    type: 'Polygon' as const,
    coordinates: [
      [
        [-79.5, 43.6],
        [-79.3, 43.6],
        [-79.3, 43.8],
        [-79.5, 43.8],
        [-79.5, 43.6],
      ],
    ],
  };

  const putShape = (listId: string, zoneId: string, codes: string[]) =>
    api
      .put(`/api/zone-lists/${listId}/zones/${zoneId}/shape`)
      .set(asAdmin())
      .send({ geojson: SQUARE, codes });

  it('keeps drawn codes and typed codes side by side', async () => {
    const list = await newList();
    const zone = await newZone(list, 'Toronto');

    await putCodes(list, zone, 'M4C').expect(200);
    await putShape(list, zone, ['M5V']).expect(200);

    const res = await api.get(`/api/zone-lists/${list}/zones/${zone}`).set(asOperator());
    const bySource = Object.fromEntries(
      res.body.codes.map((c: { code: string; source: string }) => [c.code, c.source]),
    );

    expect(bySource).toEqual({ M4C: 'TYPED', M5V: 'MAP' });
    // Saving welds the drawn areas, and that always lands as a MultiPolygon —
    // one shape per zone, counted the same way whether it has one area or six.
    expect(res.body.shape.geojson.type).toBe('MultiPolygon');
  }, TIMEOUT);

  it('replaces only the drawn codes when the shape is redrawn', async () => {
    const list = await newList();
    const zone = await newZone(list, 'Toronto');

    await putCodes(list, zone, 'M4C').expect(200);
    await putShape(list, zone, ['M5V', 'M5B']).expect(200);
    await putShape(list, zone, ['M5V']).expect(200);

    const res = await api.get(`/api/zone-lists/${list}/zones/${zone}`).set(asOperator());
    expect(res.body.codes.map((c: { code: string }) => c.code).sort()).toEqual(['M4C', 'M5V']);
  }, TIMEOUT);

  it('keeps the codes when the drawing is forgotten', async () => {
    const list = await newList();
    const zone = await newZone(list, 'Toronto');
    await putShape(list, zone, ['M5V']).expect(200);

    await api.delete(`/api/zone-lists/${list}/zones/${zone}/shape`).set(asAdmin()).expect(204);

    const res = await api.get(`/api/zone-lists/${list}/zones/${zone}`).set(asOperator());
    expect(res.body.shape).toBeNull();
    expect(res.body.codes.map((c: { code: string }) => c.code)).toEqual(['M5V']);
    expect(await resolveZone(list, 'M5V 3L9')).toMatchObject({ ok: true, zoneName: 'Toronto' });
  }, TIMEOUT);

  it('refuses a drawn code that another zone already holds', async () => {
    const list = await newList();
    const downtown = await newZone(list, 'Downtown');
    const toronto = await newZone(list, 'Toronto');

    await putCodes(list, downtown, 'M5V').expect(200);
    const res = await putShape(list, toronto, ['M5V']);

    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('Downtown');
  }, TIMEOUT);
});

describe('resolving an address to a zone', () => {
  it('prefers a full code over the FSA it sits inside', async () => {
    const list = await newList();
    const city = await newZone(list, 'Calgary');
    const airport = await newZone(list, 'YYC Airport');

    await putCodes(list, city, 'T2E').expect(200);
    await putCodes(list, airport, 'T2E6W5').expect(200);

    const carveOut = await resolveZone(list, 'T2E 6W5');
    const ordinary = await resolveZone(list, 'T2E 4N1');

    expect(carveOut).toMatchObject({ ok: true, zoneName: 'YYC Airport', via: 'FULL' });
    expect(ordinary).toMatchObject({ ok: true, zoneName: 'Calgary', via: 'FSA' });
  }, TIMEOUT);

  it('reports an unmapped code and a malformed one differently', async () => {
    const list = await newList();
    const zone = await newZone(list, 'Toronto');
    await putCodes(list, zone, 'M5V').expect(200);

    expect(await resolveZone(list, 'X0A 0H0')).toEqual({ ok: false, reason: 'ZONE_NOT_FOUND' });
    expect(await resolveZone(list, 'M5V')).toEqual({ ok: false, reason: 'INVALID_POSTAL_CODE' });
  }, TIMEOUT);

  it('ignores the codes of a deactivated zone', async () => {
    const list = await newList();
    const zone = await newZone(list, 'Toronto');
    await putCodes(list, zone, 'M5V').expect(200);

    await api
      .patch(`/api/zone-lists/${list}/zones/${zone}`)
      .set(asAdmin())
      .send({ active: false })
      .expect(200);

    expect(await resolveZone(list, 'M5V 3L9')).toEqual({ ok: false, reason: 'ZONE_NOT_FOUND' });
  }, TIMEOUT);
});

describe('rate cards', () => {
  it('refuses a second active card whose dates overlap for the same customer', async () => {
    const list = await newList();
    await newCard(list, '2031-01-01', '2031-12-31');

    const res = await api.post('/api/rate-cards').set(asAdmin()).send({
      name: unique('overlap'),
      clientId: ref.clientId,
      zoneListId: list,
      validFrom: '2031-06-01',
      validTo: '2032-06-01',
    });

    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('already covers this customer');
  }, TIMEOUT);

  it('allows a card that starts the day after the last one ends', async () => {
    const list = await newList();
    await newCard(list, '2033-01-01', '2033-12-31');
    await newCard(list, '2034-01-01', '2034-12-31');
  }, TIMEOUT);

  it('rejects an expiry before the effective date', async () => {
    const list = await newList();
    const res = await api.post('/api/rate-cards').set(asAdmin()).send({
      name: unique('backwards'),
      clientId: ref.clientId,
      zoneListId: list,
      validFrom: '2035-12-31',
      validTo: '2035-01-01',
    });

    expect(res.status).toBe(400);
  }, TIMEOUT);
});

describe('additional services on a card', () => {
  async function newService(defaultRate: number | null): Promise<{ id: string; name: string }> {
    const name = unique('svc');
    const res = await api
      .post('/api/additional-services')
      .set(asAdmin())
      .send({ name, ...(defaultRate === null ? {} : { defaultRate }) });
    if (res.status !== 201) {
      throw new Error(`service failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    serviceIds.push(res.body.id);
    return { id: res.body.id, name };
  }

  const find = (body: Array<{ id: string }>, id: string) => body.find((s) => s.id === id);

  it('shows the catalogue price until the card overrides it', async () => {
    const list = await newList();
    const card = await newCard(list, '2041-01-01', '2041-12-31');
    const svc = await newService(25);

    const res = await api.get(`/api/rate-cards/${card}/services`).set(asOperator());

    expect(res.status).toBe(200);
    expect(find(res.body, svc.id)).toMatchObject({
      defaultRate: 25,
      override: null,
      effective: { rate: 25 },
    });
  }, TIMEOUT);

  it('lets one customer depart from the standard price', async () => {
    const list = await newList();
    const card = await newCard(list, '2042-01-01', '2042-12-31');
    const svc = await newService(25);

    const res = await api
      .put(`/api/rate-cards/${card}/services`)
      .set(asAdmin())
      .send({ additionalServiceId: svc.id, rate: 40 });

    expect(res.status).toBe(200);
    expect(find(res.body, svc.id)).toMatchObject({
      defaultRate: 25,
      override: { rate: 40 },
      effective: { rate: 40 },
    });
  }, TIMEOUT);

  it('clearing the box goes back to the catalogue price', async () => {
    const list = await newList();
    const card = await newCard(list, '2043-01-01', '2043-12-31');
    const svc = await newService(25);

    await api
      .put(`/api/rate-cards/${card}/services`)
      .set(asAdmin())
      .send({ additionalServiceId: svc.id, rate: 40 })
      .expect(200);

    const res = await api
      .put(`/api/rate-cards/${card}/services`)
      .set(asAdmin())
      .send({ additionalServiceId: svc.id, rate: null });

    // No row of nulls: the override is gone, so a later change to the
    // catalogue default reaches this card again.
    expect(find(res.body, svc.id)).toMatchObject({ override: null, effective: { rate: 25 } });
  }, TIMEOUT);

  it('keeps a service with no standard price unpriced until a card sets one', async () => {
    const list = await newList();
    const card = await newCard(list, '2044-01-01', '2044-12-31');
    const svc = await newService(null);

    const before = await api.get(`/api/rate-cards/${card}/services`).set(asOperator());
    expect(find(before.body, svc.id)).toMatchObject({
      defaultRate: null,
      effective: { rate: null },
    });

    const after = await api
      .put(`/api/rate-cards/${card}/services`)
      .set(asAdmin())
      .send({ additionalServiceId: svc.id, rate: 12.5 });

    expect(find(after.body, svc.id)).toMatchObject({ effective: { rate: 12.5 } });
  }, TIMEOUT);
});

describe('route rates', () => {
  it('prices one direction only', async () => {
    const list = await newList();
    const toronto = await newZone(list, 'Toronto');
    const vancouver = await newZone(list, 'Vancouver');
    const card = await newCard(list, '2036-01-01', '2036-12-31');

    await api
      .put(`/api/rate-cards/${card}/rates`)
      .set(asAdmin())
      .send({
        serviceLevelId,
        freightItemId,
        toZoneId: vancouver,
        baseRate: 300,
        freeKm: 50,
        ratePerKm: 1.1,
        freeWaitMinutes: 30,
        waitRatePerMinute: 0.75,
      })
      .expect(200);

    const res = await api.get(`/api/rate-cards/${card}/rates`).set(asOperator());

    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      baseRate: 300,
      freeKm: 50,
      ratePerKm: 1.1,
      freeWaitMinutes: 30,
      waitRatePerMinute: 0.75,
    });
    expect(res.body[0].toZone.name).toBe('Vancouver');
    // Nothing was invented for the journey home.
    expect(res.body.some((r: { toZone: { name: string } }) => r.toZone.name === 'Toronto')).toBe(false);
  }, TIMEOUT);

  it('overwrites the same combination instead of adding a second row', async () => {
    const list = await newList();
    const zone = await newZone(list, 'Toronto');
    const card = await newCard(list, '2037-01-01', '2037-12-31');

    const cell = {
      serviceLevelId,
      freightItemId,
      toZoneId: zone,
    };
    await api.put(`/api/rate-cards/${card}/rates`).set(asAdmin()).send({ ...cell, baseRate: 10 }).expect(200);
    await api.put(`/api/rate-cards/${card}/rates`).set(asAdmin()).send({ ...cell, baseRate: 25 }).expect(200);

    const res = await api.get(`/api/rate-cards/${card}/rates`).set(asOperator());
    expect(res.body).toHaveLength(1);
    expect(res.body[0].baseRate).toBe(25);
  }, TIMEOUT);

  it('refuses a zone that belongs to a different list', async () => {
    const mine = await newList();
    const theirs = await newList();
    const here = await newZone(mine, 'Toronto');
    const elsewhere = await newZone(theirs, 'Toronto');
    const card = await newCard(mine, '2038-01-01', '2038-12-31');

    const res = await api.put(`/api/rate-cards/${card}/rates`).set(asAdmin()).send({
      serviceLevelId,
      freightItemId,
      toZoneId: elsewhere,
      baseRate: 10,
    });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('That zone must belong to');
  }, TIMEOUT);

  it('deactivates a priced zone instead of deleting it', async () => {
    const list = await newList();
    const zone = await newZone(list, 'Toronto');
    const card = await newCard(list, '2039-01-01', '2039-12-31');

    await api
      .put(`/api/rate-cards/${card}/rates`)
      .set(asAdmin())
      .send({ serviceLevelId, freightItemId, toZoneId: zone, baseRate: 10 })
      .expect(200);

    const res = await api.delete(`/api/zone-lists/${list}/zones/${zone}`).set(asAdmin());

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(false);
    expect(res.body.zone.active).toBe(false);
  }, TIMEOUT);

  it('keeps rates out of a driver\'s reach', async () => {
    const list = await newList();
    const card = await newCard(list, '2040-01-01', '2040-12-31');
    const res = await api.get(`/api/rate-cards/${card}/rates`);
    expect(res.status).toBe(401);
  }, TIMEOUT);
});

/*
 * The calculator. It stores nothing, so every test here is a read — the only
 * rows created are the card and zone list the quote is asked about.
 *
 * Each card takes a year of its own: two active cards for one customer may not
 * overlap, and every card in this file belongs to the same seeded customer.
 */
describe('pricing a job against a card', () => {
  let nextYear = 2050;

  async function priceable() {
    const year = nextYear++;
    const list = await newList();
    const toronto = await newZone(list, 'Toronto');
    const vancouver = await newZone(list, 'Vancouver');
    await putCodes(list, toronto, 'M5V').expect(200);
    await putCodes(list, vancouver, 'V6B').expect(200);

    const card = await newCard(list, `${year}-01-01`, `${year}-12-31`);
    await api
      .put(`/api/rate-cards/${card}/rates`)
      .set(asAdmin())
      .send({
        serviceLevelId,
        freightItemId,
        toZoneId: vancouver,
        baseRate: 300,
        freeKm: 50,
        ratePerKm: 1.1,
        freeWaitMinutes: 30,
        waitRatePerMinute: 0.75,
      })
      .expect(200);

    return { list, card, toronto, vancouver, year };
  }

  const ask = (card: string, year: number, body: Record<string, unknown> = {}) =>
    api
      .post(`/api/rate-cards/${card}/quote`)
      .set(asOperator())
      .send({
        pickupPostalCode: 'M5V 3L9',
        deliveryPostalCode: 'V6B 1A1',
        serviceLevelId,
        freightItemId,
        on: `${year}-06-01`,
        ...body,
      });

  it('charges the base, the distance past the free kilometres and the wait past the free minutes', async () => {
    const { card, year } = await priceable();

    const res = await ask(card, year, { distanceKm: 100, waitMinutes: 50 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.from.zoneName).toBe('Toronto');
    expect(res.body.to.zoneName).toBe('Vancouver');
    // 300 base + 50 km x 1.1 + 20 min x 0.75
    expect(res.body.total).toBe(370);
    expect(res.body.lines.map((l: { key: string }) => l.key)).toEqual(['base', 'distance', 'waiting']);
    expect(res.body.warnings).toEqual([]);
  }, TIMEOUT);

  it('charges nothing for distance or waiting inside the free allowance', async () => {
    const { card, year } = await priceable();

    const res = await ask(card, year, { distanceKm: 10, waitMinutes: 5 });

    expect(res.body.total).toBe(300);
  }, TIMEOUT);

  it('takes a bare FSA as readily as a full postcode', async () => {
    const { card, year } = await priceable();

    const res = await ask(card, year, { pickupPostalCode: 'm5v', deliveryPostalCode: 'V6B' });

    expect(res.body.ok).toBe(true);
    expect(res.body.from.matched).toBe('M5V');
  }, TIMEOUT);

  it('names the postcode that is not in the zone list, and prices nothing', async () => {
    const { card, year } = await priceable();

    const res = await ask(card, year, { deliveryPostalCode: 'K1A 0B1' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.problem).toContain('K1A 0B1');
    expect(res.body.total).toBe(0);
    expect(res.body.lines).toEqual([]);
  }, TIMEOUT);

  it('says so when the journey has no rate rather than inventing one', async () => {
    const { card, year } = await priceable();

    // The reverse journey was never priced, and nothing falls back to it.
    const res = await ask(card, year, {
      pickupPostalCode: 'V6B 1A1',
      deliveryPostalCode: 'M5V 3L9',
    });

    expect(res.body.ok).toBe(false);
    expect(res.body.problem).toContain('no rate');
    expect(res.body.total).toBe(0);
  }, TIMEOUT);

  it('still prices a day outside the window, but says it would not apply', async () => {
    const { card, year } = await priceable();

    const res = await ask(card, year, { on: `${year + 5}-06-01` });

    expect(res.body.ok).toBe(true);
    expect(res.body.total).toBe(300);
    expect(res.body.warnings.join(' ')).toContain(`${year}-01-01`);
  }, TIMEOUT);

  it('adds the extras at this customer\'s price', async () => {
    const { card, year } = await priceable();
    const name = unique('svc');
    const created = await api
      .post('/api/additional-services')
      .set(asAdmin())
      .send({ name, defaultRate: 25 })
      .expect(201);
    serviceIds.push(created.body.id);

    const standard = await ask(card, year, { additionalServiceIds: [created.body.id] });
    expect(standard.body.total).toBe(325);

    await api
      .put(`/api/rate-cards/${card}/services`)
      .set(asAdmin())
      .send({ additionalServiceId: created.body.id, rate: 40 })
      .expect(200);

    const theirs = await ask(card, year, { additionalServiceIds: [created.body.id] });
    expect(theirs.body.total).toBe(340);
    expect(theirs.body.lines.at(-1)).toMatchObject({ label: name, amount: 40 });
  }, TIMEOUT);

  it('rejects an unknown service level outright', async () => {
    const { card, year } = await priceable();

    const res = await ask(card, year, { serviceLevelId: 'no-such-level' });

    expect(res.status).toBe(400);
  }, TIMEOUT);

  it('is closed to anonymous callers', async () => {
    const { card } = await priceable();

    const res = await api.post(`/api/rate-cards/${card}/quote`).send({
      pickupPostalCode: 'M5V 3L9',
      deliveryPostalCode: 'V6B 1A1',
      serviceLevelId,
      freightItemId,
    });

    expect(res.status).toBe(401);
  }, TIMEOUT);
});
