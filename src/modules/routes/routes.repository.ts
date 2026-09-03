import { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma.js';

/** All Prisma access for planned routes. */

const stopSelect = {
  id: true,
  consignmentId: true,
  seq: true,
  plannedLat: true,
  plannedLng: true,
  consignment: {
    select: {
      id: true,
      orderNo: true,
      status: true,
      driverId: true,
      priority: true,
      receiverName: true,
      receiverLine1: true,
      receiverProvince: true,
      receiverCity: true,
      receiverLat: true,
      receiverLng: true,
      pickupAfter: true,
      deliverBefore: true,
    },
  },
} satisfies Prisma.RouteStopSelect;

const routeSelect = {
  id: true,
  driverId: true,
  status: true,
  version: true,
  startLat: true,
  startLng: true,
  startLabel: true,
  endLat: true,
  endLng: true,
  endLabel: true,
  sequenceSource: true,
  optimisedAt: true,
  plannedDistanceM: true,
  plannedDurationS: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
  driver: { select: { id: true, name: true, code: true, mapColorIndex: true } },
  stops: { select: stopSelect, orderBy: { seq: 'asc' } },
} satisfies Prisma.RouteSelect;

export type RouteRow = Prisma.RouteGetPayload<{ select: typeof routeSelect }>;
export type RouteStopRow = RouteRow['stops'][number];

export function findActiveByDriver(driverId: string) {
  return prisma.route.findFirst({
    where: { driverId, status: 'ACTIVE' },
    select: routeSelect,
  });
}

export function findById(routeId: string) {
  return prisma.route.findUnique({ where: { id: routeId }, select: routeSelect });
}

/** An earlier save with the same key — how a double-tapped Save stays harmless. */
export function findByClientKey(driverId: string, clientKey: string) {
  return prisma.route.findFirst({
    where: { driverId, clientKey },
    select: routeSelect,
  });
}

/** The orders being routed, with everything needed to validate and plan them. */
export function findConsignmentsForRoute(ids: string[]) {
  return prisma.consignment.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      orderNo: true,
      status: true,
      driverId: true,
      receiverLat: true,
      receiverLng: true,
      senderLat: true,
      senderLng: true,
      senderLine1: true,
    },
  });
}

export function findDriver(driverId: string) {
  return prisma.driver.findUnique({
    where: { id: driverId },
    select: { id: true, name: true, active: true, onShift: true },
  });
}

export interface CreateRouteInput {
  driverId: string;
  start: { lat: number; lng: number; label?: string };
  end?: { lat: number; lng: number; label?: string };
  createdById: string;
  clientKey?: string;
  plannedDistanceM: number | null;
  plannedDurationS: number | null;
  /** Already in visiting order — index 0 is stop 1. */
  stops: { consignmentId: string; plannedLat: number; plannedLng: number }[];
}

/**
 * Save a plan, retiring whatever the driver had before.
 *
 * One transaction, because the partial unique index allows exactly one ACTIVE route
 * per driver: the old one must be superseded and the new one inserted together, or
 * the insert collides with a row that has not moved yet.
 */
export async function createRoute(input: CreateRouteInput) {
  return prisma.$transaction(async (tx) => {
    await tx.route.updateMany({
      where: { driverId: input.driverId, status: 'ACTIVE' },
      data: { status: 'SUPERSEDED' },
    });

    const route = await tx.route.create({
      data: {
        driverId: input.driverId,
        startLat: input.start.lat,
        startLng: input.start.lng,
        startLabel: input.start.label ?? null,
        endLat: input.end?.lat ?? null,
        endLng: input.end?.lng ?? null,
        endLabel: input.end?.label ?? null,
        sequenceSource: 'OPTIMISED',
        optimisedAt: new Date(),
        plannedDistanceM: input.plannedDistanceM,
        plannedDurationS: input.plannedDurationS,
        createdById: input.createdById,
        clientKey: input.clientKey ?? null,
        stops: {
          create: input.stops.map((s, i) => ({
            consignmentId: s.consignmentId,
            seq: i + 1,
            plannedLat: s.plannedLat,
            plannedLng: s.plannedLng,
          })),
        },
      },
      select: { id: true },
    });

    return route.id;
  });
}

/**
 * Rewrite the visiting order.
 *
 * Every row is updated inside one transaction, which only works because the
 * (routeId, seq) constraint is DEFERRABLE — moving stop 7 to position 3 shifts four
 * other rows, and an immediately-checked constraint would reject the first write
 * against a row that has not moved yet.
 *
 * `version` is checked in the same statement that increments it, so two dispatchers
 * reordering at once cannot both win: the loser updates zero rows and gets a 409.
 */
export async function reorderStops(
  routeId: string,
  expectedVersion: number,
  orderedConsignmentIds: string[],
  manual: boolean,
) {
  return prisma.$transaction(async (tx) => {
    const bumped = await tx.route.updateMany({
      where: { id: routeId, version: expectedVersion },
      data: {
        version: { increment: 1 },
        sequenceSource: manual ? 'MANUAL' : 'OPTIMISED',
        ...(manual ? {} : { optimisedAt: new Date() }),
      },
    });
    if (bumped.count === 0) return false;

    for (let i = 0; i < orderedConsignmentIds.length; i += 1) {
      await tx.routeStop.updateMany({
        where: { routeId, consignmentId: orderedConsignmentIds[i] },
        data: { seq: i + 1 },
      });
    }
    return true;
  });
}

/** Store recomputed totals. Cosmetic — the read path recomputes them anyway. */
export function setPlannedTotals(routeId: string, distanceM: number, durationS: number) {
  return prisma.route.update({
    where: { id: routeId },
    data: { plannedDistanceM: distanceM, plannedDurationS: durationS },
    select: { id: true },
  });
}

export function closeActiveForDriver(driverId: string) {
  return prisma.route.updateMany({
    where: { driverId, status: 'ACTIVE' },
    data: { status: 'SUPERSEDED' },
  });
}
