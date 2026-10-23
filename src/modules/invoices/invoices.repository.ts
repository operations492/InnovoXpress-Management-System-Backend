import { prisma } from '../../config/prisma.js';

export function findClient(clientId: string) {
  return prisma.client.findUnique({
    where: { id: clientId },
    select: { id: true, name: true, code: true },
  });
}

/** The client's one active plan, with its whole price grid. */
export function findActivePlan(clientId: string) {
  return prisma.ratePlan.findFirst({
    where: { clientId, active: true },
    select: {
      id: true,
      name: true,
      currency: true,
      baseRate: true,
      includedKm: true,
      blockKm: true,
      blockRate: true,
      items: {
        select: {
          serviceLevelId: true,
          additionalServiceId: true,
          freightItemId: true,
          price: true,
        },
      },
    },
  });
}

/** Names for the ids the caller selected, so every line can be labelled. */
export async function findNames(ids: {
  serviceLevelIds: string[];
  additionalServiceIds: string[];
  freightItemIds: string[];
}) {
  const select = { id: true, name: true };
  const [serviceLevels, additionalServices, freightItems] = await Promise.all([
    prisma.serviceLevel.findMany({ where: { id: { in: ids.serviceLevelIds } }, select }),
    prisma.additionalService.findMany({ where: { id: { in: ids.additionalServiceIds } }, select }),
    prisma.freightItem.findMany({ where: { id: { in: ids.freightItemIds } }, select }),
  ]);
  return {
    serviceLevels: new Map(serviceLevels.map((e) => [e.id, e.name])),
    additionalServices: new Map(additionalServices.map((e) => [e.id, e.name])),
    freightItems: new Map(freightItems.map((e) => [e.id, e.name])),
  };
}
