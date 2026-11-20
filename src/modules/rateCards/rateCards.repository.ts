import type { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma.js';

export const cardSelect = {
  id: true,
  name: true,
  clientId: true,
  zoneListId: true,
  validFrom: true,
  validTo: true,
  currency: true,
  active: true,
  memo: true,
  levyPct: true,
  createdAt: true,
  updatedAt: true,
  client: { select: { id: true, name: true, code: true } },
  zoneList: { select: { id: true, name: true } },
  _count: { select: { rates: true } },
} satisfies Prisma.RateCardSelect;

export type CardRow = Prisma.RateCardGetPayload<{ select: typeof cardSelect }>;

export const rateSelect = {
  id: true,
  serviceLevelId: true,
  freightItemId: true,
  toZoneId: true,
  baseRate: true,
  freeKm: true,
  ratePerKm: true,
  freeWaitMinutes: true,
  waitRatePerMinute: true,
  active: true,
  updatedAt: true,
  serviceLevel: { select: { id: true, name: true } },
  freightItem: { select: { id: true, name: true } },
  toZone: { select: { id: true, name: true } },
} satisfies Prisma.RouteRateSelect;

export type RateRow = Prisma.RouteRateGetPayload<{ select: typeof rateSelect }>;

/* ------------------------------------------------------------------ cards */

export function listCards(clientId: string | undefined, includeInactive: boolean): Promise<CardRow[]> {
  return prisma.rateCard.findMany({
    where: {
      ...(clientId ? { clientId } : {}),
      ...(includeInactive ? {} : { active: true }),
    },
    select: cardSelect,
    orderBy: [{ validFrom: 'desc' }, { name: 'asc' }],
  });
}

export function findCardById(id: string): Promise<CardRow | null> {
  return prisma.rateCard.findUnique({ where: { id }, select: cardSelect });
}

/**
 * Another active card for the same customer whose dates touch these.
 *
 * Inclusive on both ends, matching the exclusion constraint in the database:
 * a card ending on the 31st and one starting on the 31st overlap on that day,
 * and "which price applied" must never have two answers.
 */
export function findOverlappingCard(
  clientId: string,
  validFrom: Date,
  validTo: Date,
  exceptId?: string,
) {
  return prisma.rateCard.findFirst({
    where: {
      clientId,
      active: true,
      validFrom: { lte: validTo },
      validTo: { gte: validFrom },
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { id: true, name: true, validFrom: true, validTo: true },
  });
}

export function createCard(data: Prisma.RateCardUncheckedCreateInput): Promise<CardRow> {
  return prisma.rateCard.create({ data, select: cardSelect });
}

export function updateCard(id: string, data: Prisma.RateCardUpdateInput): Promise<CardRow> {
  return prisma.rateCard.update({ where: { id }, data, select: cardSelect });
}

export function deleteCard(id: string) {
  return prisma.rateCard.delete({ where: { id }, select: { id: true } });
}

/**
 * What still depends on a card, for the delete guard:
 *  - `invoiceLines`: jobs already priced from it (their invoice keeps the money,
 *    but would lose which card it came from);
 *  - `unbilledJobs`: this customer's delivered, not-yet-invoiced jobs whose
 *    delivery falls inside the card's dates — the ones it would price next.
 * `validTo` is a date, so the window runs to the end of that day.
 */
export async function countCardUsage(card: {
  id: string;
  clientId: string;
  validFrom: Date;
  validTo: Date;
}) {
  const end = new Date(card.validTo.getTime() + 24 * 60 * 60 * 1000);
  const [invoiceLines, unbilledJobs] = await Promise.all([
    prisma.invoiceLine.count({ where: { rateCardId: card.id } }),
    prisma.consignment.count({
      where: {
        clientId: card.clientId,
        status: 'DELIVERED',
        invoiceLine: null,
        deliveredAt: { gte: card.validFrom, lt: end },
      },
    }),
  ]);
  return { invoiceLines, unbilledJobs };
}

/* ------------------------------------------------------------------ rates */

export function listRates(
  rateCardId: string,
  filter: { serviceLevelId?: string; freightItemId?: string },
): Promise<RateRow[]> {
  return prisma.routeRate.findMany({
    where: {
      rateCardId,
      ...(filter.serviceLevelId ? { serviceLevelId: filter.serviceLevelId } : {}),
      ...(filter.freightItemId ? { freightItemId: filter.freightItemId } : {}),
    },
    select: rateSelect,
    orderBy: [{ toZone: { name: 'asc' } }],
  });
}

export function findRateById(rateCardId: string, rateId: string): Promise<RateRow | null> {
  return prisma.routeRate.findFirst({ where: { id: rateId, rateCardId }, select: rateSelect });
}

/**
 * Write one cell. An upsert rather than a create, because the grid is edited by
 * typing over whatever is already in the box — the operator is not told to
 * delete the old price first, and should not be.
 */
export function upsertRate(
  key: {
    rateCardId: string;
    serviceLevelId: string;
    freightItemId: string;
    toZoneId: string;
  },
  values: {
    baseRate: number;
    freeKm: number;
    ratePerKm: number;
    freeWaitMinutes: number;
    waitRatePerMinute: number;
  },
): Promise<RateRow> {
  return prisma.routeRate.upsert({
    where: {
      rateCardId_serviceLevelId_freightItemId_toZoneId: key,
    },
    create: { ...key, ...values },
    update: { ...values, active: true },
    select: rateSelect,
  });
}

/** The one row that prices a job into this zone, or nothing. */
export function findRateByRoute(key: {
  rateCardId: string;
  serviceLevelId: string;
  freightItemId: string;
  toZoneId: string;
}): Promise<RateRow | null> {
  return prisma.routeRate.findUnique({
    where: { rateCardId_serviceLevelId_freightItemId_toZoneId: key },
    select: rateSelect,
  });
}

/**
 * Every rate into this zone on this service level, whatever the freight item.
 *
 * The fallback behind loose matching: the item table is barely involved in
 * pricing, so a job with no freight item still has to be quotable. Ordered so
 * the answer is stable rather than whatever the planner happens to return —
 * an unstable pick would make the same job price two different ways.
 */
export function findRatesForZone(key: {
  rateCardId: string;
  serviceLevelId: string;
  toZoneId: string;
}): Promise<RateRow[]> {
  return prisma.routeRate.findMany({
    where: { ...key, active: true },
    orderBy: [{ freightItem: { sortOrder: 'asc' } }, { freightItem: { name: 'asc' } }],
    select: rateSelect,
  });
}

export function deleteRate(rateId: string) {
  return prisma.routeRate.delete({ where: { id: rateId }, select: { id: true } });
}

/* ------------------------------------------------- additional services */

/**
 * Every live additional service, with this card's override attached where one
 * exists. One query rather than two lists the caller has to stitch together,
 * and it is the shape the editor's dialog renders directly.
 */
export function listServicesForCard(rateCardId: string) {
  return prisma.additionalService.findMany({
    where: { active: true },
    select: {
      id: true,
      name: true,
      sortOrder: true,
      defaultRate: true,
      trigger: true,
      cardServices: { where: { rateCardId }, select: { id: true, rate: true } },
    },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
}

export type ServiceForCardRow = Awaited<ReturnType<typeof listServicesForCard>>[number];

export function upsertCardService(
  rateCardId: string,
  additionalServiceId: string,
  values: { rate: number },
) {
  return prisma.rateCardService.upsert({
    where: { rateCardId_additionalServiceId: { rateCardId, additionalServiceId } },
    create: { rateCardId, additionalServiceId, ...values },
    update: values,
    select: { id: true },
  });
}

export function deleteCardService(rateCardId: string, additionalServiceId: string) {
  return prisma.rateCardService.deleteMany({ where: { rateCardId, additionalServiceId } });
}

export function findAdditionalServiceById(id: string) {
  return prisma.additionalService.findUnique({
    where: { id },
    select: { id: true, name: true, active: true },
  });
}

/* --------------------------------------------------------- referenced rows */

export function findClientById(id: string) {
  return prisma.client.findUnique({ where: { id }, select: { id: true, name: true, active: true } });
}

export function findZoneListById(id: string) {
  return prisma.zoneList.findUnique({ where: { id }, select: { id: true, name: true, active: true } });
}

/** How many of these zone ids actually belong to that list. */
export function countZonesInList(zoneListId: string, zoneIds: string[]): Promise<number> {
  return prisma.zone.count({ where: { zoneListId, id: { in: zoneIds } } });
}

export function findServiceLevelById(id: string) {
  return prisma.serviceLevel.findUnique({ where: { id }, select: { id: true, name: true } });
}

export function findFreightItemById(id: string) {
  return prisma.freightItem.findUnique({ where: { id }, select: { id: true, name: true } });
}
