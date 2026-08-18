import { ConsignmentStatus, Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma.js';
import { MAP_TAB_STATUSES, type MapTab } from '../../constants/mapTabs.js';

/*
 * Every database call for the dispatch map. Read-only — the map adds no writes;
 * View, Edit and Assign all go through the existing consignments endpoints.
 */

/* ------------------------------------------------------------------ */
/* selects                                                             */
/* ------------------------------------------------------------------ */

/**
 * Lean enough to plot, rich enough for the click-widget — see the plan's §1.
 *
 * Deliberately absent: `items` (a nested select would make Prisma issue a second
 * query and ship every item row; the quantity comes from an aggregate instead),
 * `generalNote` (unbounded text), sender contact details, proofs and tracking
 * events. Those belong to `GET /api/consignments/:id`.
 */
const pinSelect = {
  id: true,
  orderNo: true,
  status: true,
  taskType: true,
  priority: true,
  senderLat: true,
  senderLng: true,
  receiverLat: true,
  receiverLng: true,
  receiverName: true,
  receiverLine1: true,
  receiverArea: true,
  receiverCity: true,
  readyBy: true,
  deliverBy: true,
  driver: { select: { id: true, name: true, mapColorIndex: true } },
} satisfies Prisma.ConsignmentSelect;

const rosterSelect = {
  id: true,
  name: true,
  code: true,
  active: true,
  onShift: true,
  mapColorIndex: true,
} satisfies Prisma.DriverSelect;

export type PinRow = Prisma.ConsignmentGetPayload<{ select: typeof pinSelect }>;
export type RosterRow = Prisma.DriverGetPayload<{ select: typeof rosterSelect }>;

/* ------------------------------------------------------------------ */
/* where                                                              */
/* ------------------------------------------------------------------ */

export interface PinFilters {
  tab?: MapTab;
  driverIds?: string[];
  clientId?: string;
  q?: string;
  from?: Date;
  to?: Date;
  completedSince: Date;
}

/**
 * Built as an explicit AND array rather than by assigning onto one object.
 *
 * Two of these clauses are themselves ORs — the completion window and the free
 * text — and assigning `where.OR` twice would silently drop the first. That is
 * the same class of bug as the consignments list, where `unassigned=true`
 * overwrites `driverId`.
 *
 * The time axis is `deliverBy`/`deliveredAt`, NOT `createdAt`: an order created
 * Monday for Tuesday delivery must not vanish from a Tuesday board.
 */
export function buildPinWhere(f: PinFilters): Prisma.ConsignmentWhereInput {
  const and: Prisma.ConsignmentWhereInput[] = [
    // Open work, plus recent completions. Keyed on `deliveredAt` rather than
    // `deliverBy`, because a delivered task may never have had a deadline.
    {
      OR: [
        { status: { not: ConsignmentStatus.DELIVERED } },
        { status: ConsignmentStatus.DELIVERED, deliveredAt: { gte: f.completedSince } },
      ],
    },
  ];

  if (f.tab) {
    and.push({ status: { in: [...MAP_TAB_STATUSES[f.tab]] } });
  }

  // `tab` and `driverIds` are orthogonal and AND together. Asking for
  // unassigned tasks belonging to a driver yields nothing, which is honest.
  if (f.driverIds && f.driverIds.length > 0) {
    and.push({ driverId: { in: f.driverIds } });
  }

  if (f.clientId) and.push({ clientId: f.clientId });

  if (f.from || f.to) {
    and.push({
      deliverBy: {
        ...(f.from ? { gte: f.from } : {}),
        ...(f.to ? { lte: f.to } : {}),
      },
    });
  }

  if (f.q) {
    // Narrower than the consignments list's seven columns on purpose: these are
    // the four a dispatcher actually searches on a map, and each one is an
    // unindexed ILIKE.
    const like = { contains: f.q, mode: 'insensitive' as const };
    and.push({
      OR: [
        { orderNo: like },
        { clientReference: like },
        { receiverName: like },
        { receiverCity: like },
      ],
    });
  }

  return { AND: and };
}

/** The same filters minus `tab` — facet counts must not depend on the open tab. */
export function withoutTab(f: PinFilters): PinFilters {
  const { tab: _tab, ...rest } = f;
  return rest;
}

/* ------------------------------------------------------------------ */
/* reads                                                              */
/* ------------------------------------------------------------------ */

/**
 * Deterministic ordering matters even unpaginated: without it the sidebar
 * reshuffles between refetches. Prisma needs `nulls` spelled out — a task with
 * no deadline sorts last, not first.
 */
export function findPins(where: Prisma.ConsignmentWhereInput, limit: number) {
  return prisma.consignment.findMany({
    where,
    select: pinSelect,
    orderBy: [{ deliverBy: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
    take: limit,
  });
}

/**
 * One aggregate for every badge.
 *
 * Because the three tabs partition the status enum (see constants/mapTabs.ts),
 * this single groupBy yields the tab counts, the eight-way legend and the total.
 * Three separate `count()` calls would be three round trips for less.
 */
export function countByStatus(where: Prisma.ConsignmentWhereInput) {
  return prisma.consignment.groupBy({
    by: ['status'],
    where,
    _count: { _all: true },
  });
}

/**
 * Per-driver counts over the SAME where as the pins.
 *
 * Not the roster's `activeLoad`, which counts all-time non-delivered with no
 * filters — under a date filter that would show "36 assigned" beside four pins,
 * and get reported as a bug.
 */
export function countByDriver(where: Prisma.ConsignmentWhereInput) {
  return prisma.consignment.groupBy({
    by: ['driverId'],
    where,
    _count: { _all: true },
  });
}

/**
 * Quantity for the widget, as one aggregate rather than a nested relation.
 *
 * A nested `items` select makes Prisma run a second query and return every item
 * row — roughly 3× the consignments — to be summed in Node. This returns one
 * pre-summed row per task instead.
 */
export function sumQtyByConsignment(ids: string[]) {
  if (ids.length === 0) return Promise.resolve([]);
  return prisma.item.groupBy({
    by: ['consignmentId'],
    where: { consignmentId: { in: ids } },
    _sum: { qty: true },
  });
}

/**
 * The DRIVERS tab roster.
 *
 * A deactivated driver still holding open work is included regardless: their
 * pins carry a driverId, and if the roster omitted it those pins could not be
 * labelled or filtered.
 */
export function findRoster(includeInactive: boolean) {
  return prisma.driver.findMany({
    where: includeInactive
      ? {}
      : {
          OR: [
            { active: true },
            { consignments: { some: { status: { not: ConsignmentStatus.DELIVERED } } } },
          ],
        },
    orderBy: { name: 'asc' },
    select: rosterSelect,
  });
}

/** Which palette slots are already taken, so a new driver gets the least-used. */
export function countDriversByColor() {
  return prisma.driver.groupBy({
    by: ['mapColorIndex'],
    _count: { _all: true },
  });
}
