import type { Prisma } from '@prisma/client';
import { ConsignmentStatus } from '@prisma/client';
import { prisma } from '../../config/prisma.js';

/**
 * All Prisma access for drivers lives here.
 *
 * The services above must not import `prisma` — that is the boundary that keeps
 * the business rules testable without a database, and it is the layer the
 * drivers module skipped while it was growing.
 */

/** Console roster: each driver with the number of jobs still on their plate. */
export function findDriversWithLoad(where: Prisma.DriverWhereInput) {
  return prisma.driver.findMany({
    where,
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      code: true,
      mobile: true,
      active: true,
      onShift: true,
      shiftStartedAt: true,
      shiftEndedAt: true,
      _count: {
        select: {
          consignments: { where: { status: { not: ConsignmentStatus.DELIVERED } } },
        },
      },
    },
  });
}

// findActiveDriversForPicker / findDriverForSession are gone along with the
// password-free sign-in they served.

export function findDriverById(id: string) {
  return prisma.driver.findUnique({ where: { id }, select: { id: true, name: true } });
}

/** The jobs assigned to one driver. Scoping is the caller's responsibility. */
export function findConsignmentsForDriver(driverId: string, includeDelivered: boolean) {
  return prisma.consignment.findMany({
    where: {
      driverId,
      ...(includeDelivered ? {} : { status: { not: ConsignmentStatus.DELIVERED } }),
    },
    orderBy: [{ deliverBy: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      orderNo: true,
      status: true,
      priority: true,
      taskType: true,
      client: { select: { name: true } },
      senderName: true,
      senderPhone: true,
      senderLine1: true,
      senderProvince: true,
      senderCity: true,
      senderInstructions: true,
      receiverName: true,
      receiverPhone: true,
      receiverLine1: true,
      receiverProvince: true,
      receiverCity: true,
      receiverNotes: true,
      readyBy: true,
      deliverBy: true,
      generalNote: true,
      items: {
        select: { id: true, description: true, qty: true, weightKg: true, packageType: true },
      },
      proofs: { select: { leg: true, capturedAt: true } },
    },
  });
}

export type DriverConsignmentRow = Awaited<
  ReturnType<typeof findConsignmentsForDriver>
>[number];
