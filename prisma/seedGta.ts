/**
 * Additive load data: 200 unassigned deliveries around Mississauga, ON.
 *
 * NOT part of `npm run seed`, and deliberately not destructive — it inserts and
 * touches nothing that already exists. Every row it creates carries the `GTA-`
 * order-number prefix so the whole batch can be found and removed again:
 *
 *     npx tsx prisma/seedGta.ts          # insert 200
 *     npx tsx prisma/seedGta.ts --clean  # remove them
 *
 * The prefix also keeps it clear of `order_counters`: the real allocator numbers
 * orders by client code (DRZ / APX / TCS), so a separate prefix cannot collide with
 * a number the API will hand out later.
 *
 * ⚠️ `npm run seed` still truncates everything, including these.
 *
 * (This was `seedNust.ts`, 200 drops around NUST Islamabad, before the move to
 * Canadian addressing. Same generator, same determinism — new geography.)
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../src/config/prisma.js';

/**
 * Airport Corporate Centre, Mississauga — the L4W the postal-code work is
 * modelled on. Whatever OSRM extract is loaded must cover the GTA or these
 * orders will list but not route.
 */
const CENTRE = { lat: 43.628, lng: -79.626 };

/** How far out the drops are scattered around each zone's own centre. */
const RADIUS_KM = 2.5;

const COUNT = 200;
const PREFIX = 'GTA';

/**
 * Zones around the depot, each pinned to its **real FSA** — the first three
 * characters of the postal code, which is the unit Canada Post actually sorts
 * by and therefore the one a delivery zone is drawn around. Offsets are roughly
 * where each FSA sits relative to the depot.
 *
 * This replaces the free-text neighbourhood the Islamabad version used: province
 * is now a fixed 'ON' for every row, so the FSA is the only field left carrying
 * "which part of town".
 */
const ZONES = [
  { fsa: 'L4W', dLat: 0.0, dLng: 0.0 },
  { fsa: 'L4V', dLat: 0.03, dLng: -0.01 },
  { fsa: 'L4T', dLat: 0.045, dLng: -0.02 },
  { fsa: 'L4Z', dLat: -0.012, dLng: -0.01 },
  { fsa: 'L5R', dLat: -0.018, dLng: -0.032 },
  { fsa: 'L5B', dLat: -0.035, dLng: -0.016 },
  { fsa: 'L5M', dLat: -0.052, dLng: -0.075 },
  { fsa: 'L5N', dLat: -0.039, dLng: -0.092 },
];

const STREETS = [
  'Explorer Drive',
  'Matheson Boulevard East',
  'Eglinton Avenue West',
  'Britannia Road East',
  'Derry Road East',
  'Dixie Road',
  'Tomken Road',
  'Hurontario Street',
  'Burnhamthorpe Road West',
  'Rathburn Road East',
  'Central Parkway West',
  'Mavis Road',
];

const FIRST = ['Emily', 'Liam', 'Priya', 'Noah', 'Fatima', 'Ethan', 'Chloe', 'Omar', 'Sofia', 'Jacob', 'Aisha', 'Lucas'];
const LAST = ['Tremblay', 'Nguyen', 'Patel', 'MacDonald', 'Singh', 'Roy', 'Chen', 'Gagnon', 'Brown', 'Okafor'];
const GOODS = ['Wireless earbuds', 'Winter gloves', 'Kitchen blender', 'Novel paperback', 'Phone case', 'Desk lamp', 'Running shoes', 'Water bottle'];

/**
 * The 20 letters Canada Post uses. D, F, I, O, Q and U are absent everywhere —
 * they misread as digits or as each other on a sorting machine — so generating
 * from the full alphabet would produce codes the CHECK constraint rejects.
 */
const LDU_LETTERS = 'ABCEGHJKLMNPRSTVWXYZ';

/**
 * Deterministic pseudo-random, seeded by index.
 *
 * A fixed sequence means two runs produce the same map, which matters when you are
 * comparing a route before and after a change rather than chasing a new scatter.
 */
function rand(i: number, salt: number): number {
  const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/** A point inside the radius, area-uniform rather than bunched at the centre. */
function scatter(i: number, base: { lat: number; lng: number }) {
  const angle = rand(i, 1) * Math.PI * 2;
  // sqrt, otherwise uniform radius crowds every point into the middle.
  const dist = Math.sqrt(rand(i, 2)) * RADIUS_KM;
  const dLat = (dist / 111) * Math.cos(angle);
  const dLng = (dist / (111 * Math.cos((base.lat * Math.PI) / 180))) * Math.sin(angle);
  return { lat: +(base.lat + dLat).toFixed(6), lng: +(base.lng + dLng).toFixed(6) };
}

/** `L4W 5H8` — canonical shape, so it survives both Zod and the CHECK. */
function postal(fsa: string, i: number): string {
  const d1 = Math.floor(rand(i, 6) * 10);
  const l = LDU_LETTERS[Math.floor(rand(i, 7) * LDU_LETTERS.length)];
  const d2 = Math.floor(rand(i, 8) * 10);
  return `${fsa} ${d1}${l}${d2}`;
}

async function clean() {
  const { count } = await prisma.consignment.deleteMany({
    where: { orderNo: { startsWith: `${PREFIX}-` } },
  });
  console.log(`✓ removed ${count} ${PREFIX}- orders`);
}

async function main() {
  if (process.argv.includes('--clean')) {
    await clean();
    return;
  }

  const client = await prisma.client.findFirstOrThrow({
    where: { active: true },
    select: { id: true, name: true },
  });
  const admin = await prisma.user.findFirst({
    where: { role: 'admin' },
    select: { id: true },
  });

  const existing = await prisma.consignment.count({
    where: { orderNo: { startsWith: `${PREFIX}-` } },
  });
  if (existing > 0) {
    console.log(`· ${existing} ${PREFIX}- orders already present — run with --clean first`);
    return;
  }

  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  const HOUR = 3_600_000;
  // 08:00 today, so the whole batch shares one plausible working day.
  const windowStart = new Date(new Date().setHours(8, 0, 0, 0));

  const rows: Prisma.ConsignmentCreateManyInput[] = [];

  for (let i = 0; i < COUNT; i += 1) {
    const zone = ZONES[i % ZONES.length];
    const drop = scatter(i, {
      lat: CENTRE.lat + zone.dLat,
      lng: CENTRE.lng + zone.dLng,
    });

    const name = `${FIRST[i % FIRST.length]} ${LAST[(i * 3) % LAST.length]}`;
    const house = 100 + Math.floor(rand(i, 3) * 800);
    const street = STREETS[Math.floor(rand(i, 4) * STREETS.length)];

    rows.push({
      orderNo: `${PREFIX}-${stamp}-${String(i + 1).padStart(4, '0')}`,
      clientId: client.id,
      status: 'UNASSIGNED',
      driverId: null,
      priority: i % 17 === 0 ? 'HIGH' : 'NORMAL',
      taskType: 'DELIVERY',

      // One collection point for the whole batch — the depot a route starts from.
      senderName: 'Innovo Xpress Mississauga Depot',
      senderPhone: '+1 905 555 0000',
      senderLine1: '5985 Explorer Drive, Dock 1',
      senderCity: 'Mississauga',
      senderProvince: 'ON',
      senderPostcode: 'L4W 5K6',
      senderLat: CENTRE.lat,
      senderLng: CENTRE.lng,

      receiverName: name,
      receiverPhone: `+1 ${['416', '647', '905', '289', '437'][i % 5]} 555 ${String(1000 + ((i * 79) % 9000))}`,
      receiverLine1: `${house} ${street}`,
      receiverCity: 'Mississauga',
      receiverProvince: 'ON',
      receiverPostcode: postal(zone.fsa, i),
      // The coordinate a route is planned against. Without it the order is listed
      // but cannot be routed, which the create endpoint refuses by name.
      receiverLat: drop.lat,
      receiverLng: drop.lng,

      // A same-day run: collect this morning, deliver by end of day. The four
      // windows are NOT NULL, so every seeded row has to carry a real plan.
      pickupAfter: windowStart,
      pickupBefore: new Date(windowStart.getTime() + 3 * HOUR),
      deliverAfter: new Date(windowStart.getTime() + 3 * HOUR),
      deliverBefore: new Date(windowStart.getTime() + 9 * HOUR),
      generalNote: null,
      createdByUserId: admin?.id ?? null,
      lastUpdatedByUserId: admin?.id ?? null,
    });
  }

  await prisma.consignment.createMany({ data: rows });

  // Items in one pass, so the map widget and the list show a real quantity.
  const created = await prisma.consignment.findMany({
    where: { orderNo: { startsWith: `${PREFIX}-${stamp}-` } },
    select: { id: true, orderNo: true },
  });

  await prisma.item.createMany({
    data: created.flatMap((c, i) => {
      const lines = 1 + (i % 3);
      return Array.from({ length: lines }, (_, k) => ({
        consignmentId: c.id,
        description: GOODS[(i + k) % GOODS.length],
        qty: 1 + ((i + k) % 3),
        weightKg: +(0.2 + rand(i + k, 5) * 2).toFixed(2),
        packageType: (['BOX', 'ENVELOPE', 'BOTTLE'] as const)[(i + k) % 3],
      }));
    }),
  });

  console.log(`✓ ${created.length} unassigned orders around Mississauga, ON (client: ${client.name})`);
  console.log(`  centre ${CENTRE.lat}, ${CENTRE.lng} · ${ZONES.length} FSAs · scattered within ${RADIUS_KM} km`);
  console.log(`  remove with:  npx tsx prisma/seedGta.ts --clean`);
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
