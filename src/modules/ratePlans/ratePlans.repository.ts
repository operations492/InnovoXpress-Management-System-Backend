import type { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma.js';

export const planSelect = {
  id: true,
  clientId: true,
  client: { select: { id: true, name: true, code: true } },
  name: true,
  active: true,
  currency: true,
  baseRate: true,
  includedKm: true,
  blockKm: true,
  blockRate: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.RatePlanSelect;

export type PlanRow = Prisma.RatePlanGetPayload<{ select: typeof planSelect }>;

const itemSelect = {
  id: true,
  serviceLevelId: true,
  additionalServiceId: true,
  freightItemId: true,
  price: true,
} satisfies Prisma.RatePlanItemSelect;

export type ItemRow = Prisma.RatePlanItemGetPayload<{ select: typeof itemSelect }>;

export function list(filter: { clientId?: string; includeInactive: boolean }): Promise<PlanRow[]> {
  return prisma.ratePlan.findMany({
    where: {
      ...(filter.clientId ? { clientId: filter.clientId } : {}),
      ...(filter.includeInactive ? {} : { active: true }),
    },
    select: planSelect,
    orderBy: [{ client: { name: 'asc' } }, { name: 'asc' }],
  });
}

export function findById(id: string): Promise<PlanRow | null> {
  return prisma.ratePlan.findUnique({ where: { id }, select: planSelect });
}

export function findItems(ratePlanId: string): Promise<ItemRow[]> {
  return prisma.ratePlanItem.findMany({ where: { ratePlanId }, select: itemSelect });
}

export function findByClientAndName(clientId: string, name: string) {
  return prisma.ratePlan.findFirst({
    where: { clientId, name: { equals: name, mode: 'insensitive' } },
    select: { id: true, name: true },
  });
}

export function findActiveForClient(clientId: string, exceptId?: string) {
  return prisma.ratePlan.findFirst({
    where: { clientId, active: true, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true, name: true },
  });
}

export function findClientById(clientId: string) {
  return prisma.client.findUnique({ where: { id: clientId }, select: { id: true, name: true } });
}

/** The three catalogues the editor prices, active entries only, in list order. */
export async function findCatalogues() {
  const order = [{ sortOrder: 'asc' as const }, { name: 'asc' as const }];
  const select = { id: true, name: true };
  const [serviceLevels, additionalServices, freightItems] = await Promise.all([
    prisma.serviceLevel.findMany({ where: { active: true }, select, orderBy: order }),
    prisma.additionalService.findMany({ where: { active: true }, select, orderBy: order }),
    prisma.freightItem.findMany({ where: { active: true }, select, orderBy: order }),
  ]);
  return { serviceLevels, additionalServices, freightItems };
}

export function create(data: Prisma.RatePlanCreateInput): Promise<PlanRow> {
  return prisma.ratePlan.create({ data, select: planSelect });
}

export function update(id: string, data: Prisma.RatePlanUpdateInput): Promise<PlanRow> {
  return prisma.ratePlan.update({ where: { id }, data, select: planSelect });
}

export function remove(id: string) {
  // Items go with it: a price list without its plan prices nothing (FK Cascade).
  return prisma.ratePlan.delete({ where: { id }, select: { id: true } });
}

/**
 * Replace the whole grid in one transaction.
 *
 * ponytail: wholesale replace, not a keyed diff — row ids change on every save.
 * Nothing references a rate_plan_items id today, so this is invisible; switch to
 * a keyed diff the moment an invoice line points at one.
 */
export function replaceItems(
  ratePlanId: string,
  rows: Array<{
    serviceLevelId?: string | undefined;
    additionalServiceId?: string | undefined;
    freightItemId?: string | undefined;
    price: number;
  }>,
) {
  return prisma.$transaction(async (tx) => {
    await tx.ratePlanItem.deleteMany({ where: { ratePlanId } });
    if (rows.length > 0) {
      await tx.ratePlanItem.createMany({
        data: rows.map((r) => ({
          ratePlanId,
          serviceLevelId: r.serviceLevelId ?? null,
          additionalServiceId: r.additionalServiceId ?? null,
          freightItemId: r.freightItemId ?? null,
          price: r.price,
        })),
      });
    }
  });
}
