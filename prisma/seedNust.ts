/**
 * Additive load data: 200 unassigned deliveries around NUST, Islamabad.
 *
 * NOT part of `npm run seed`, and deliberately not destructive — it inserts and
 * touches nothing that already exists. Every row it creates carries the `NST-`
 * order-number prefix so the whole batch can be found and removed again:
 *
 *     npx tsx prisma/seedNust.ts          # insert 200
 *     npx tsx prisma/seedNust.ts --clean  # remove them
 *
 * The prefix also keeps it clear of `order_counters`: the real allocator numbers
 * orders by client code (DRZ / APX / TCS), so a separate prefix cannot collide with
 * a number the API will hand out later.
 *
 * ⚠️ `npm run seed` still truncates everything, including these.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../src/config/prisma.js';

/** NUST H-12. Verified against the local OSRM extract, which covers Islamabad. */
const CENTRE = { lat: 33.6425, lng: 72.9905 };

/** How far out the drops are scattered. ~5km keeps them in one deliverable sector. */
const RADIUS_KM = 5;

const COUNT = 200;
const PREFIX = 'NST';

/**
 * Sectors around NUST, so addresses read like real Islamabad ones instead of
 * "Delivery 47". Offsets are roughly where each sector actually sits.
 */
const SECTORS = [
  { name: 'H-12', dLat: 0.0, dLng: 0.0 },
  { name: 'G-13', dLat: -0.012, dLng: 0.02 },
  { name: 'G-12', dLat: -0.014, dLng: 0.038 },
  { name: 'H-11', dLat: 0.004, dLng: 0.042 },
  { name: 'G-11', dLat: -0.016, dLng: 0.055 },
  { name: 'H-13', dLat: 0.012, dLng: -0.018 },
  { name: 'Golra Mor', dLat: 0.022, dLng: -0.006 },
  { name: 'E-11', dLat: 0.028, dLng: 0.03 },
];

const FIRST = ['Ayesha', 'Bilal', 'Hina', 'Usman', 'Sana', 'Tariq', 'Maryam', 'Kamran', 'Nadia', 'Fahad', 'Zara', 'Imran'];
const LAST = ['Khan', 'Malik', 'Butt', 'Cheema', 'Qureshi', 'Abbasi', 'Rana', 'Shah', 'Awan', 'Gill'];
const GOODS = ['Wireless earbuds', 'Cotton kurta', 'Kitchen blender', 'Novel paperback', 'Phone case', 'Desk lamp', 'Running shoes', 'Water bottle'];

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
  const rows: Prisma.ConsignmentCreateManyInput[] = [];

  for (let i = 0; i < COUNT; i += 1) {
    const sector = SECTORS[i % SECTORS.length];
    const drop = scatter(i, {
      lat: CENTRE.lat + sector.dLat,
      lng: CENTRE.lng + sector.dLng,
    });

    const name = `${FIRST[i % FIRST.length]} ${LAST[(i * 3) % LAST.length]}`;
    const house = 100 + Math.floor(rand(i, 3) * 800);
    const street = 1 + Math.floor(rand(i, 4) * 60);

    rows.push({
      orderNo: `${PREFIX}-${stamp}-${String(i + 1).padStart(4, '0')}`,
      clientId: client.id,
      status: 'UNASSIGNED',
      driverId: null,
      priority: i % 17 === 0 ? 'HIGH' : 'NORMAL',
      taskType: 'DELIVERY',

      // One collection point for the whole batch — the depot a route starts from.
      senderName: 'NUST Fulfilment Centre',
      senderPhone: '+92 51 9085 0000',
      senderLine1: 'Gate 3, NUST H-12 Campus',
      senderArea: 'H-12',
      senderCity: 'Islamabad',
      senderPostcode: '44000',
      senderLat: CENTRE.lat,
      senderLng: CENTRE.lng,

      receiverName: name,
      receiverPhone: `+92 3${String(10 + (i % 90))} ${String(1000000 + i * 7919).slice(0, 7)}`,
      receiverLine1: `House ${house}, Street ${street}`,
      receiverArea: sector.name,
      receiverCity: 'Islamabad',
      receiverPostcode: '44000',
      // The coordinate a route is planned against. Without it the order is listed
      // but cannot be routed, which the create endpoint refuses by name.
      receiverLat: drop.lat,
      receiverLng: drop.lng,

      readyBy: null,
      deliverBy: null,
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

  console.log(`✓ ${created.length} unassigned orders around NUST, Islamabad (client: ${client.name})`);
  console.log(`  centre ${CENTRE.lat}, ${CENTRE.lng} · scattered within ${RADIUS_KM} km`);
  console.log(`  remove with:  npx tsx prisma/seedNust.ts --clean`);
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
