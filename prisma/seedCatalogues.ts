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
  console.log(`✓ additional services: ${ADDITIONAL_SERVICES.length}`);

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
  // A priced entry is left alone: the FK is Restrict, and removing it would take
  // a rate plan's price with it.
  const [pricedServices, pricedItems] = await Promise.all([
    prisma.ratePlanItem.findMany({
      where: { additionalServiceId: { not: null } },
      select: { additionalServiceId: true },
    }),
    prisma.ratePlanItem.findMany({
      where: { freightItemId: { not: null } },
      select: { freightItemId: true },
    }),
  ]);

  const keepServices = new Set(pricedServices.map((r) => r.additionalServiceId as string));
  const keepItems = new Set(pricedItems.map((r) => r.freightItemId as string));

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
    console.log(`- kept ${s.name}: priced by a rate plan`);
  }
  for (const f of items.filter((f) => keepItems.has(f.id))) {
    console.log(`- kept ${f.name}: priced by a rate plan`);
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
