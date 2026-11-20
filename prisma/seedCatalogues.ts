/**
 * Additive seed: the two priced catalogues — additional services and freight
 * items — so a rate plan has something to price.
 *
 *   npx tsx prisma/seedCatalogues.ts           add or refresh them
 *   npx tsx prisma/seedCatalogues.ts --clean   remove them again
 *
 * Erases nothing else. Every row is upserted on its unique name, so re-running
 * updates sort order rather than duplicating. `--clean` skips any entry a rate
 * plan already prices, because deleting it would silently drop that price.
 */
import { prisma } from '../src/config/prisma.js';

/** The system-added charge. Its name is fixed so the seed can find it again. */
const AFTER_HOURS = 'After Hour Charge';

/** Accessorials a Canadian courier actually bills for. */
const ADDITIONAL_SERVICES = [
  'Lift Gate',
  'Inside Delivery',
  'Residential Delivery',
  'Appointment Delivery',
  'Wait Time',
  'After Hours',
  'Weekend Delivery',
  'Dangerous Goods',
  'Heated Service',
  'Redelivery',
];

/** How the freight is presented, not what is in it. */
const FREIGHT_ITEMS = [
  'Skid',
  'Pallet',
  'Carton',
  'Envelope',
  'Tube',
  'Crate',
  'Drum',
  'Roll',
  'Bundle',
  'Tote',
];

async function seed() {
  for (const [i, name] of ADDITIONAL_SERVICES.entries()) {
    await prisma.additionalService.upsert({
      where: { name },
      create: { name, sortOrder: i, active: true },
      update: { sortOrder: i },
    });
  }
  // The one charge the system applies on its own. It is seeded rather than left
  // to be typed in, because the quote finds it by trigger and expects it to exist.
  await prisma.additionalService.upsert({
    where: { name: AFTER_HOURS },
    create: {
      name: AFTER_HOURS,
      sortOrder: ADDITIONAL_SERVICES.length,
      active: true,
      trigger: 'AFTER_HOURS',
    },
    update: { trigger: 'AFTER_HOURS' },
  });

  console.log(`✓ additional services: ${ADDITIONAL_SERVICES.length + 1}`);

  for (const [i, name] of FREIGHT_ITEMS.entries()) {
    await prisma.freightItem.upsert({
      where: { name },
      create: { name, sortOrder: i, active: true },
      update: { sortOrder: i },
    });
  }
  console.log(`✓ freight items: ${FREIGHT_ITEMS.length}`);
}

async function clean() {
  // A freight item named on a route rate is left alone: the FK is Restrict, and
  // removing it would take a rate card's price with it. Additional services are
  // priced by nothing since rate cards replaced rate plans, so none are held.
  const pricedItems = await prisma.routeRate.findMany({
    select: { freightItemId: true },
    distinct: ['freightItemId'],
  });

  const keepServices = new Set<string>();
  const keepItems = new Set(pricedItems.map((r) => r.freightItemId));

  const services = await prisma.additionalService.findMany({
    where: { name: { in: ADDITIONAL_SERVICES } },
    select: { id: true, name: true },
  });
  const items = await prisma.freightItem.findMany({
    where: { name: { in: FREIGHT_ITEMS } },
    select: { id: true, name: true },
  });

  const removableServices = services.filter((s) => !keepServices.has(s.id));
  const removableItems = items.filter((f) => !keepItems.has(f.id));

  for (const s of services.filter((s) => keepServices.has(s.id))) {
    console.log(`- kept ${s.name}: priced by a rate card`);
  }
  for (const f of items.filter((f) => keepItems.has(f.id))) {
    console.log(`- kept ${f.name}: priced by a rate card`);
  }

  const a = await prisma.additionalService.deleteMany({
    where: { id: { in: removableServices.map((s) => s.id) } },
  });
  const b = await prisma.freightItem.deleteMany({
    where: { id: { in: removableItems.map((f) => f.id) } },
  });
  console.log(`✓ removed ${a.count} additional service(s), ${b.count} freight item(s)`);
}

await (process.argv.includes('--clean') ? clean() : seed());
await prisma.$disconnect();
