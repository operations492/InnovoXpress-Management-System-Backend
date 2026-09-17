/**
 * Additive seed: Canadian courier companies as clients, each with a real GTA
 * pickup address.
 *
 *   npx tsx prisma/seedCouriers.ts           add or refresh them
 *   npx tsx prisma/seedCouriers.ts --clean   remove them again
 *
 * Safe to re-run: every row is upserted on its unique `code`, so a second run
 * updates rather than duplicates. `npm run seed` still deletes these along with
 * everything else.
 *
 * Addresses, coordinates and phone numbers come from TomTom Search, not from
 * memory. Where the geocoder returned only an FSA (the first three characters)
 * and no `extendedPostalCode`, `postcode` is left null rather than guessing the
 * last three — the coordinate is what the system routes on anyway. `contactName`
 * is null for the same reason: the geocoder does not know who works the dock.
 */
import { prisma } from '../src/config/prisma.js';

type CourierSeed = {
  name: string;
  code: string;
  phone: string | null;
  line1: string;
  city: string;
  postcode: string | null;
  lat: number;
  lng: number;
};

const COURIERS: CourierSeed[] = [
  {
    name: 'Purolator',
    code: 'PURO',
    phone: '+1 888-744-7123',
    line1: '2600 Meadowvale Boulevard',
    city: 'Mississauga',
    postcode: null, // geocoder returned the FSA "L5N" only
    lat: 43.606181,
    lng: -79.772869,
  },
  {
    name: 'Canpar Express',
    code: 'CNPR',
    phone: '+1 800-387-9335',
    line1: '205 New Toronto Street',
    city: 'Etobicoke',
    postcode: 'M8V 2E8',
    lat: 43.604775,
    lng: -79.513051,
  },
  {
    name: 'Loomis Express',
    code: 'LOOM',
    phone: '+1 647-239-8858',
    line1: '4455 Sheppard Avenue East',
    city: 'Scarborough',
    postcode: 'M1S 1V3',
    lat: 43.787771,
    lng: -79.265879,
  },
  {
    name: 'GLS Canada',
    code: 'GLSC',
    phone: '+1 888-463-4266',
    line1: '300 Biscayne Crescent',
    city: 'Brampton',
    postcode: null, // FSA "L6W" only
    lat: 43.67668,
    lng: -79.71063,
  },
  {
    name: 'Day and Ross',
    code: 'DYRS',
    phone: '+1 877-726-3329',
    line1: '6975 Menkes Drive',
    city: 'Mississauga',
    postcode: 'L5S 1W1',
    lat: 43.680253,
    lng: -79.667128,
  },
  {
    name: 'ICS Courier',
    code: 'ICSC',
    phone: null,
    line1: '55 Horner Avenue',
    city: 'Etobicoke',
    postcode: null, // FSA "M8Z" only
    lat: 43.614762,
    lng: -79.516688,
  },
  {
    name: 'Manitoulin Transport',
    code: 'MANI',
    phone: '+1 905-670-5982',
    line1: '1335 Shawson Drive',
    city: 'Mississauga',
    postcode: 'L4W 5J6',
    lat: 43.651517,
    lng: -79.648048,
  },
  {
    name: 'Cardinal Couriers',
    code: 'CARD',
    phone: '+1 905-507-8844',
    line1: '400 Brunel Road',
    city: 'Mississauga',
    postcode: 'L4Z 2C2',
    lat: 43.631345,
    lng: -79.665535,
  },
];

const CODES = COURIERS.map((c) => c.code);

async function clean() {
  // Never remove a client that has orders: that is the same rule the API
  // enforces with a 409, and it would take the order numbers with it.
  const inUse = await prisma.client.findMany({
    where: { code: { in: CODES }, consignments: { some: {} } },
    select: { code: true, _count: { select: { consignments: true } } },
  });

  const keep = new Set(inUse.map((c) => c.code));
  for (const c of inUse) {
    console.log(`- kept ${c.code}: ${c._count.consignments} order(s) reference it`);
  }

  const removable = CODES.filter((code) => !keep.has(code));
  await prisma.orderCounter.deleteMany({ where: { client: { code: { in: removable } } } });
  const { count } = await prisma.client.deleteMany({ where: { code: { in: removable } } });
  console.log(`✓ removed ${count} courier client(s)`);
}

async function seed() {
  for (const c of COURIERS) {
    const data = {
      name: c.name,
      contactName: null,
      phone: c.phone,
      email: null,
      line1: c.line1,
      city: c.city,
      province: 'ON',
      postcode: c.postcode,
      lat: c.lat,
      lng: c.lng,
      instructions: null,
    };

    await prisma.client.upsert({
      where: { code: c.code },
      create: { ...data, code: c.code, active: true },
      update: data,
    });
    console.log(`✓ ${c.code}  ${c.name} — ${c.line1}, ${c.city} ON`);
  }
  console.log(`\n✓ ${COURIERS.length} courier clients ready`);
}

await (process.argv.includes('--clean') ? clean() : seed());
await prisma.$disconnect();
