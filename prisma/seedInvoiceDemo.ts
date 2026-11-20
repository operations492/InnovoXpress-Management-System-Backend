/**
 * A complete, realistic world for testing invoicing — and nothing more.
 *
 * One customer, one zone list with two real GTA zones, one rate card with a
 * levy, and **two delivered jobs** ready to be billed. That is everything the
 * invoice screens need and no more, because the point is to check the flow,
 * not to generate load.
 *
 *     npx tsx prisma/seedInvoiceDemo.ts          # insert
 *     npx tsx prisma/seedInvoiceDemo.ts --clean  # remove exactly what it made
 *
 * Additive and non-destructive: it creates its own client, so it cannot
 * disturb Daraz, Apple Express or TCS, and `--clean` removes only rows carrying
 * this client or the `IXD-` order prefix.
 *
 * ⚠️ `npm run seed` still truncates everything, including these.
 */
import { prisma } from '../src/config/prisma.js';

const CLIENT_CODE = 'IXD';
const CLIENT_NAME = 'Northwind Pharma (invoice demo)';
const PREFIX = 'IXD';
const LIST_NAME = 'GTA Demo Zones';
const CARD_NAME = 'Northwind Pharma — Standard';

/** 27.5%, the rate the real Innovo invoices carry. */
const LEVY_PCT = 27.5;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * Two zones, each a real set of Forward Sortation Areas.
 *
 * These are the unit Canada Post actually sorts by, and the unit the zone map
 * captures, so a demo built on anything else would price differently from a
 * zone an operator draws.
 */
const ZONES = [
  {
    name: 'Toronto Core',
    codes: ['M5A', 'M5B', 'M5C', 'M5E', 'M5G', 'M5H', 'M5J', 'M5V'],
    baseRate: 15.95,
    ratePerKm: 1.85,
    freeKm: 10,
  },
  {
    name: 'Peel Region',
    codes: ['L4W', 'L4X', 'L4Y', 'L4Z', 'L5A', 'L5B', 'L5M', 'L5N'],
    baseRate: 22.5,
    ratePerKm: 1.65,
    freeKm: 15,
  },
];

/** The depot everything is collected from. */
const DEPOT = {
  name: 'Northwind Pharma — Mississauga',
  line1: '2180 Dunwin Drive, Unit 1',
  city: 'Mississauga',
  province: 'ON',
  postcode: 'L5M 5M8',
  lat: 43.5384,
  lng: -79.6895,
};

/**
 * Two jobs, deliberately unalike.
 *
 * The first is an ordinary daytime run into Toronto. The second is collected at
 * 21:00, which is outside business hours, so it should attract the After Hours
 * charge — the two together show the whole ladder and the difference between
 * them is only the clock.
 */
const JOBS = [
  {
    receiverName: 'Mercer, Nicola',
    line1: '500 University Ave',
    city: 'Toronto',
    postcode: 'M5G 1X8',
    lat: 43.6577,
    lng: -79.3886,
    /** Local hours on the delivery day. Inside any sane window. */
    pickupHour: 9,
    deliverHour: 14,
    /** Ticked by the operator when the order was logged. */
    services: ['Tailgate Service', 'Residential Surcharge'],
    items: [
      { description: 'Cold-chain tote', qty: 2, weightLb: 11.4, l: 18, w: 14, h: 12 },
      { description: 'Documents envelope', qty: 1, weightLb: 0.4, l: 12, w: 9, h: 1 },
    ],
  },
  {
    receiverName: 'Coverdale Clinic — Streetsville',
    line1: '274 Queen St S',
    city: 'Mississauga',
    postcode: 'L5M 1L8',
    lat: 43.5806,
    lng: -79.7116,
    /** 21:00 collection: outside hours, so the system adds its own charge. */
    pickupHour: 21,
    deliverHour: 23,
    /** Two ticked, plus After Hours the system adds by itself — so this job
        shows both kinds of service charge side by side on the invoice, one
        editable and one not. */
    services: ['Tailgate Service', 'Dry Ice Handling'],
    items: [{ description: 'Pallet of saline', qty: 1, weightLb: 240, l: 48, w: 40, h: 52 }],
  },
];

/**
 * Accessorials for the demo, and what this customer pays for each.
 *
 * `cardRate` is deliberately not always the standard price: two are negotiated
 * away from the catalogue and one is not, so the invoice shows both "this
 * customer's price" and "standard price" and the difference is visible.
 *
 * All MANUAL. An AFTER_HOURS charge is the system's to decide and never
 * appears in a tick-list, which is the whole reason the trigger exists.
 */
const SERVICES: Array<{ name: string; defaultRate: number; cardRate: number | null }> = [
  { name: 'Tailgate Service', defaultRate: 45, cardRate: 38.5 },
  { name: 'Dry Ice Handling', defaultRate: 30, cardRate: 42 },
  { name: 'Residential Surcharge', defaultRate: 12, cardRate: 9.75 },
  /*
   * Deliberately NOT priced on this card, and attached to nothing.
   *
   * It is here to show the rule rather than to be used: the order form offers
   * only what the customer's own card prices, so this one will not appear in
   * the tick-list even though it exists in the catalogue.
   */
  { name: 'Inside Delivery', defaultRate: 25, cardRate: null },
];

/* ------------------------------------------------------------------ clean */

async function clean() {
  const client = await prisma.client.findUnique({
    where: { code: CLIENT_CODE },
    select: { id: true },
  });

  // Invoices first: their lines hold a Restrict reference to the consignments.
  if (client) {
    const n = await prisma.invoice.deleteMany({ where: { clientId: client.id } });
    if (n.count) console.log(`  removed ${n.count} invoice(s)`);
  }

  const jobs = await prisma.consignment.deleteMany({
    where: { orderNo: { startsWith: `${PREFIX}-` } },
  });
  console.log(`  removed ${jobs.count} consignment(s)`);

  if (client) {
    await prisma.rateCard.deleteMany({ where: { clientId: client.id } });
    await prisma.client.delete({ where: { id: client.id } });
    console.log('  removed the rate card and the customer');
  }

  /*
   * The catalogue is deliberately left alone.
   *
   * `additional_services` is shared: another customer's card may price
   * "Tailgate Service" by now, and a demo seed has no business deleting a row
   * somebody else depends on. The per-customer prices go with the rate card
   * (Cascade) and the per-order ticks go with the orders (Cascade), so nothing
   * this seed owns survives — only rows it had no right to own in the first
   * place.
   */

  const list = await prisma.zoneList.findFirst({
    where: { name: LIST_NAME },
    select: { id: true },
  });
  if (list) {
    await prisma.zoneList.delete({ where: { id: list.id } });
    console.log('  removed the zone list');
  }

  console.log('✓ clean');
}

/* ------------------------------------------------------------------- seed */

/** Midday on a weekday a few days back, so the jobs are plausibly "delivered". */
function deliveryDay(daysAgo: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  d.setHours(0, 0, 0, 0);
  return d;
}

const at = (base: Date, hour: number) => new Date(base.getTime() + hour * HOUR);

async function main() {
  if (process.argv.includes('--clean')) return clean();

  // Re-runnable: wipe this seed's own rows first so a second run is not a
  // duplicate world. It touches nothing outside its own client and prefix.
  await clean();

  const [serviceLevel, freightItem, driver, admin] = await Promise.all([
    prisma.serviceLevel.findFirst({ where: { active: true }, orderBy: { sortOrder: 'asc' } }),
    prisma.freightItem.findFirst({ where: { active: true }, orderBy: { sortOrder: 'asc' } }),
    prisma.driver.findFirst({ where: { active: true } }),
    prisma.user.findFirst({ where: { role: 'admin' } }),
  ]);

  if (!serviceLevel) throw new Error('No active service level — seed the catalogues first.');
  if (!freightItem) throw new Error('No active freight item — seed the catalogues first.');
  if (!driver) {
    throw new Error('No active driver. A DELIVERED order must have one: the database enforces it.');
  }

  /* --- customer ---------------------------------------------------------- */
  const client = await prisma.client.create({
    data: {
      name: CLIENT_NAME,
      code: CLIENT_CODE,
      active: true,
      contactName: 'Accounts Payable',
      email: 'ap@northwind.example',
      phone: '905-555-0142',
      line1: DEPOT.line1,
      city: DEPOT.city,
      province: DEPOT.province,
      postcode: DEPOT.postcode,
      lat: DEPOT.lat,
      lng: DEPOT.lng,
      taxExempt: false,
      paymentTermsDays: 30,
    },
  });

  /* --- zones ------------------------------------------------------------- */
  const list = await prisma.zoneList.create({ data: { name: LIST_NAME } });

  const zoneIds: Record<string, string> = {};
  for (const z of ZONES) {
    const zone = await prisma.zone.create({
      data: { zoneListId: list.id, name: z.name },
    });
    zoneIds[z.name] = zone.id;
    // Codes carry the list id as well as the zone id: uniqueness is per list,
    // so the same FSA may live in two different zone books.
    await prisma.zonePostalRule.createMany({
      data: z.codes.map((code) => ({
        zoneId: zone.id,
        zoneListId: list.id,
        code,
        codeType: 'FSA' as const,
      })),
    });
  }

  /* --- rate card --------------------------------------------------------- */
  const card = await prisma.rateCard.create({
    data: {
      name: CARD_NAME,
      clientId: client.id,
      zoneListId: list.id,
      validFrom: new Date('2024-01-01'),
      validTo: new Date('2030-12-31'),
      active: true,
      levyPct: LEVY_PCT,
      currency: 'CAD',
    },
  });

  for (const z of ZONES) {
    await prisma.routeRate.create({
      data: {
        rateCardId: card.id,
        serviceLevelId: serviceLevel.id,
        freightItemId: freightItem.id,
        toZoneId: zoneIds[z.name],
        baseRate: z.baseRate,
        ratePerKm: z.ratePerKm,
        freeKm: z.freeKm,
        waitRatePerMinute: 1.25,
        freeWaitMinutes: 15,
        active: true,
      },
    });
  }

  /* --- accessorials ------------------------------------------------------- */

  /*
   * Upserted by name rather than created.
   *
   * `additional_services` is a shared catalogue: another customer's card may
   * already price "Tailgate Service", and a seed has no business replacing a
   * row somebody else depends on. Upsert touches only the default price, and
   * `--clean` leaves these alone entirely for the same reason.
   */
  const serviceIds: Record<string, string> = {};
  for (const [i, svc] of SERVICES.entries()) {
    const row = await prisma.additionalService.upsert({
      where: { name: svc.name },
      update: {},
      create: {
        name: svc.name,
        defaultRate: svc.defaultRate,
        trigger: 'MANUAL',
        active: true,
        sortOrder: 10 + i,
      },
      select: { id: true },
    });
    serviceIds[svc.name] = row.id;

    // The customer's own price, where it differs. No row means "same as the
    // catalogue" — which is one representation, not a stored null.
    if (svc.cardRate !== null) {
      await prisma.rateCardService.create({
        data: { rateCardId: card.id, additionalServiceId: row.id, rate: svc.cardRate },
      });
    }
  }

  /* --- the two delivered jobs -------------------------------------------- */
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  for (const [i, j] of JOBS.entries()) {
    const base = deliveryDay(i + 1);
    const pickupAfter = at(base, j.pickupHour);
    const deliverBefore = at(base, j.deliverHour);
    const deliveredAt = new Date(deliverBefore.getTime() - 20 * 60_000);
    const arrivedAt = new Date(deliveredAt.getTime() - 35 * 60_000);

    const job = await prisma.consignment.create({
      data: {
        orderNo: `${PREFIX}-${stamp}-${String(i + 1).padStart(4, '0')}`,
        clientId: client.id,
        clientReference: `PO-${7700 + i}`,
        // A driver comes with the status: the database enforces
        // `driverId IS NULL` if and only if status is UNASSIGNED.
        status: 'DELIVERED',
        driverId: driver.id,
        priority: 'NORMAL',
        taskType: 'DELIVERY',
        serviceLevelId: serviceLevel.id,
        freightItemId: freightItem.id,

        senderName: DEPOT.name,
        senderPhone: '905-555-0142',
        senderLine1: DEPOT.line1,
        senderCity: DEPOT.city,
        senderProvince: DEPOT.province,
        senderPostcode: DEPOT.postcode,
        senderLat: DEPOT.lat,
        senderLng: DEPOT.lng,

        receiverName: j.receiverName,
        receiverPhone: '416-555-0199',
        receiverLine1: j.line1,
        receiverCity: j.city,
        receiverProvince: 'ON',
        receiverPostcode: j.postcode,
        receiverLat: j.lat,
        receiverLng: j.lng,

        // The requested windows, which are what the After Hours charge is
        // judged on — not the moment the order was typed in.
        pickupAfter,
        pickupBefore: at(base, j.pickupHour + 1),
        deliverAfter: at(base, j.deliverHour - 1),
        deliverBefore,

        assignedAt: new Date(pickupAfter.getTime() - HOUR),
        pickedUpAt: new Date(pickupAfter.getTime() + 15 * 60_000),
        deliveredAt,

        createdByUserId: admin?.id ?? null,
        lastUpdatedByUserId: admin?.id ?? null,

        // Names only, exactly as the order form stores them. What each costs
        // is read from the rate card when the job is invoiced.
        services: {
          create: j.services.map((name) => ({ additionalServiceId: serviceIds[name] })),
        },

        items: {
          create: j.items.map((it) => ({
            description: it.description,
            qty: it.qty,
            weightLb: it.weightLb,
            lengthIn: it.l,
            widthIn: it.w,
            heightIn: it.h,
          })),
        },
      },
    });

    /*
     * Arrival at the drop, so waiting time is measurable.
     *
     * There is no `atDeliveryAt` column — waiting is read as the gap between
     * the newest AT_DELIVERY tracking event and the delivery proof. Without
     * both, the pricing service honestly reports no waiting rather than zero.
     */
    await prisma.trackingEvent.create({
      data: {
        consignmentId: job.id,
        fromStatus: 'EN_ROUTE_TO_DELIVERY',
        toStatus: 'AT_DELIVERY',
        driverId: driver.id,
        recordedAt: arrivedAt,
        note: 'Arrived at delivery (invoice demo)',
      },
    });

    console.log(
      `  ${job.orderNo}  ${j.city} ${j.postcode}  collected ${j.pickupHour}:00${
        j.pickupHour >= 18 || j.pickupHour < 8 ? '  ← after hours' : ''
      }\n      services: ${j.services.join(', ')}`,
    );
  }

  console.log(`\n✓ invoice demo ready`);
  console.log(`  customer   ${CLIENT_NAME} (${CLIENT_CODE})`);
  console.log(`  zone list  ${LIST_NAME} — ${ZONES.map((z) => z.name).join(', ')}`);
  console.log(`  rate card  ${CARD_NAME} — levy ${LEVY_PCT}%, ${serviceLevel.name} / ${freightItem.name}`);
  console.log(
    `  services   ${SERVICES.filter((s) => s.cardRate !== null)
      .map((s) => `${s.name} $${s.cardRate?.toFixed(2)}`)
      .join(', ')}`,
  );
  console.log(
    `             ${SERVICES.filter((s) => s.cardRate === null)
      .map((s) => `${s.name} (catalogue only — will NOT appear in the tick-list)`)
      .join(', ')}`,
  );
  console.log(`  2 delivered jobs, both uninvoiced`);
  console.log(`\n  Finance -> Invoices -> New invoice -> pick "${CLIENT_NAME}" -> Last 30 Days`);
  console.log(`  remove with:  npx tsx prisma/seedInvoiceDemo.ts --clean`);
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
