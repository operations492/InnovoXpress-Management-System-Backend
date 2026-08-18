import type { ConsignmentStatus, Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma.js';
import { AppError } from '../../utils/httpError.js';
import { generateOrderNo } from '../../utils/orderNo.js';
import { MAP_TAB_STATUSES } from '../../constants/mapTabs.js';
import type { ListConsignmentsQuery } from '../../schemas/query.schema.js';

/** Everything a detail view needs, in one round trip. */
export const fullInclude = {
  client: { select: { id: true, name: true, code: true } },
  driver: { select: { id: true, name: true, code: true, mobile: true } },
  items: { orderBy: { createdAt: 'asc' } },
  proofs: true,
  trackingEvents: {
    orderBy: { recordedAt: 'desc' },
    include: { driver: { select: { id: true, name: true } } },
  },
} satisfies Prisma.ConsignmentInclude;

export type FullConsignment = Prisma.ConsignmentGetPayload<{
  include: typeof fullInclude;
}>;

/** Slim projection for the grid — no tracking events, no proofs. */
export const summarySelect = {
  id: true,
  orderNo: true,
  clientReference: true,
  status: true,
  priority: true,
  taskType: true,
  senderName: true,
  senderLine1: true,
  senderCity: true,
  senderArea: true,
  senderLat: true,
  senderLng: true,
  receiverName: true,
  receiverLine1: true,
  receiverCity: true,
  receiverArea: true,
  receiverLat: true,
  receiverLng: true,
  readyBy: true,
  deliverBy: true,
  generalNote: true,
  createdAt: true,
  client: { select: { id: true, name: true, code: true } },
  driver: { select: { id: true, name: true } },
  items: { select: { qty: true, weightKg: true } },
} satisfies Prisma.ConsignmentSelect;

export type SummaryRow = Prisma.ConsignmentGetPayload<{
  select: typeof summarySelect;
}>;

export function findFullById(id: string): Promise<FullConsignment | null> {
  return prisma.consignment.findUnique({ where: { id }, include: fullInclude });
}

/**
 * A date arriving as `2026-08-13` parses to midnight, which would exclude the
 * whole day it names. Treat a midnight boundary as "end of that day".
 */
function inclusiveEnd(d: Date): Date {
  const isMidnight =
    d.getHours() === 0 &&
    d.getMinutes() === 0 &&
    d.getSeconds() === 0 &&
    d.getMilliseconds() === 0;
  if (!isMidnight) return d;
  const end = new Date(d);
  end.setHours(23, 59, 59, 999);
  return end;
}

export function buildWhere(q: ListConsignmentsQuery): Prisma.ConsignmentWhereInput {
  const where: Prisma.ConsignmentWhereInput = {};

  if (q.status) where.status = q.status;
  if (q.clientId) where.clientId = q.clientId;
  if (q.driverId) where.driverId = q.driverId;
  if (q.unassigned === 'true') where.driverId = null;

  // The tab -> status mapping is owned by `constants/mapTabs.ts`: the map's badge
  // counts derive from that same constant, so a second copy here would drift.
  // Only `status` is touched, so a tab ANDs with `driverId`/`clientId` rather than
  // replacing them. An explicit `status` is the narrower filter and keeps winning —
  // but it is intersected with the tab, so a status outside the tab yields an empty
  // set instead of one filter silently overriding the other.
  if (q.tab) {
    const tabStatuses: readonly ConsignmentStatus[] = MAP_TAB_STATUSES[q.tab];
    if (!q.status) where.status = { in: [...tabStatuses] };
    else if (!tabStatuses.includes(q.status)) where.status = { in: [] };
  }

  if (q.from || q.to) {
    where.createdAt = {
      ...(q.from ? { gte: q.from } : {}),
      ...(q.to ? { lte: inclusiveEnd(q.to) } : {}),
    };
  }

  if (q.q) {
    const like = { contains: q.q, mode: 'insensitive' as const };
    where.OR = [
      { orderNo: like },
      { clientReference: like },
      { senderName: like },
      { receiverName: like },
      { senderCity: like },
      { receiverCity: like },
      { receiverArea: like },
    ];
  }

  return where;
}

export function listSummaries(
  where: Prisma.ConsignmentWhereInput,
  orderBy: Prisma.ConsignmentOrderByWithRelationInput,
  skip: number,
  take: number,
): Promise<SummaryRow[]> {
  return prisma.consignment.findMany({ where, orderBy, skip, take, select: summarySelect });
}

export function countWhere(where: Prisma.ConsignmentWhereInput): Promise<number> {
  return prisma.consignment.count({ where });
}

export function findClientById(id: string) {
  return prisma.client.findUnique({
    select: { id: true, name: true, code: true, active: true },
    where: { id },
  });
}

/** Is this client reference already used by another order of the same client? */
export async function clientReferenceTaken(
  clientId: string,
  clientReference: string,
  exceptId?: string,
): Promise<boolean> {
  const hit = await prisma.consignment.findFirst({
    where: {
      clientId,
      clientReference,
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { id: true },
  });
  return hit !== null;
}

export function findForUpdate(id: string) {
  return prisma.consignment.findUnique({
    where: { id },
    select: { id: true, clientId: true, status: true, driverId: true },
  });
}

export function findDriverById(id: string) {
  return prisma.driver.findUnique({
    where: { id },
    // `onShift` is here so the service can refuse work to a driver who has gone
    // home; without it the check would need a second query.
    select: { id: true, name: true, code: true, active: true, onShift: true },
  });
}

/* ------------------------------------------------------------------- writes */

/**
 * Allocate an order number.
 *
 * Standalone rather than inside the insert transaction: the counter row is the
 * serialization point for every create of this client on this day, so the lock
 * must be held for one statement, not a whole multi-statement transaction.
 */
export function allocateOrderNo(clientId: string, clientCode: string) {
  return generateOrderNo(prisma, { clientId, clientCode });
}

/**
 * One create with nested writes — Prisma wraps it in a transaction, so the
 * order, its items and its opening audit event land atomically in one round trip.
 */
export function createConsignment(data: Prisma.ConsignmentCreateInput) {
  return prisma.consignment.create({ data, select: { id: true } });
}

/**
 * Compare-and-swap a status.
 *
 * `expected` is the status that was read; matching zero rows means something
 * else moved the order first, and the caller must fail rather than overwrite.
 */
export async function changeStatusTx(input: {
  id: string;
  expected: ConsignmentStatus;
  next: ConsignmentStatus;
  actorId: string;
  actorEmail: string;
  driverId?: string | null;
  note?: string | null;
  // Unchecked variant: the checked one hides relation FK scalars like driverId,
  // which assignment needs to set alongside the status in one statement.
  extraData?: Prisma.ConsignmentUncheckedUpdateManyInput;
  conflictMessage: string;
}) {
  await prisma.$transaction(
    async (tx) => {
      const { count } = await tx.consignment.updateMany({
        where: { id: input.id, status: input.expected },
        data: {
          status: input.next,
          lastUpdatedByUserId: input.actorId,
          ...(input.extraData ?? {}),
        },
      });

      if (count !== 1) throw AppError.conflict(input.conflictMessage);

      await tx.trackingEvent.create({
        data: {
          consignmentId: input.id,
          fromStatus: input.expected,
          toStatus: input.next,
          driverId: input.driverId ?? null,
          actorUserId: input.actorId,
          actorEmail: input.actorEmail,
          note: input.note ?? null,
        },
      });
    },
    // Prisma's 5s default is tight once the database is a region away.
    { timeout: 15_000 },
  );
}

/** Edit the record, and optionally reconcile its items by id. */
export async function updateConsignmentTx(input: {
  id: string;
  data: Prisma.ConsignmentUpdateInput;
  items?: Array<{ id?: string; columns: Prisma.ItemCreateWithoutConsignmentInput }>;
}) {
  await prisma.$transaction(
    async (tx) => {
      await tx.consignment.update({ where: { id: input.id }, data: input.data });

      if (!input.items) return;

      // Keyed diff rather than delete-all-and-recreate: item ids stay stable, so
      // anything referencing an item still resolves.
      const keepIds = input.items
        .map((i) => i.id)
        .filter((v): v is string => typeof v === 'string');

      await tx.item.deleteMany({
        where: {
          consignmentId: input.id,
          ...(keepIds.length ? { id: { notIn: keepIds } } : {}),
        },
      });

      for (const item of input.items) {
        if (item.id) {
          // Scoped by consignmentId so an id from another order cannot be hijacked.
          const { count } = await tx.item.updateMany({
            where: { id: item.id, consignmentId: input.id },
            data: item.columns,
          });
          if (count !== 1) {
            throw AppError.badRequest(`Item ${item.id} does not belong to this consignment`);
          }
        } else {
          await tx.item.create({ data: { consignmentId: input.id, ...item.columns } });
        }
      }
    },
    { timeout: 15_000 },
  );
}

/** Order numbers for a set of ids — so a bulk failure can name what it skipped. */
export function findOrderNumbers(ids: string[]) {
  return prisma.consignment.findMany({
    where: { id: { in: ids } },
    select: { id: true, orderNo: true },
  });
}
