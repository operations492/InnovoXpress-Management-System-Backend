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
      photoPath: true,
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
    orderBy: [{ deliverBefore: 'asc' }, { createdAt: 'asc' }],
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
      pickupAfter: true,
      deliverBefore: true,
      generalNote: true,
      documents: { select: { kind: true } },
      /// Lets the driver app order its list by most recently touched. Moves on
      /// every write — assignment, each status step, proof capture — so it is
      /// the only field in this payload that answers "what changed last".
      updatedAt: true,
      items: {
        select: {
          id: true,
          barcode: true,
          description: true,
          qty: true,
          weightLb: true,
          lengthIn: true,
          widthIn: true,
          heightIn: true,
        },
      },
      proofs: { select: { leg: true, capturedAt: true } },
    },
  });
}

export type DriverConsignmentRow = Awaited<
  ReturnType<typeof findConsignmentsForDriver>
>[number];

/* ------------------------------------------------------------ roster writes
 * The Drivers tab owns these. `users.repository` keeps its own driver writes for
 * the create-a-login-with-a-new-driver flow; the two are deliberately separate so
 * moving the roster did not touch a working account path.
 */

/** One driver, with the live load and the document paths the tab needs. */
export function findDriverDetail(id: string) {
  return prisma.driver.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      code: true,
      mobile: true,
      email: true,
      active: true,
      onShift: true,
      shiftStartedAt: true,
      shiftEndedAt: true,
      mapColorIndex: true,
      photoPath: true,
      idCardPath: true,
      createdAt: true,
      updatedAt: true,
      user: { select: { id: true, email: true } },
      _count: {
        select: {
          consignments: { where: { status: { not: ConsignmentStatus.DELIVERED } } },
        },
      },
    },
  });
}

export function createDriver(data: Prisma.DriverCreateInput) {
  return prisma.driver.create({ select: { id: true }, data });
}

export function updateDriver(id: string, data: Prisma.DriverUpdateInput) {
  return prisma.driver.update({ where: { id }, select: { id: true }, data });
}

/**
 * Employment flag. Deactivating also closes an open shift — `shiftEndedAt` is
 * stamped only if one was genuinely open, so re-deactivating never moves it.
 *
 * Twin of `users.repository.setDriverActive`. If the clock-off rule changes,
 * change both.
 */
export function setDriverActive(id: string, active: boolean) {
  if (active) {
    return prisma.driver.update({ where: { id }, select: { id: true }, data: { active: true } });
  }
  return prisma.$transaction(async (tx) => {
    await tx.driver.updateMany({
      where: { id, onShift: true },
      data: { onShift: false, shiftEndedAt: new Date() },
    });
    return tx.driver.update({
      where: { id },
      select: { id: true },
      data: { active: false, onShift: false },
    });
  });
}

export function findDocPaths(id: string) {
  return prisma.driver.findUnique({
    where: { id },
    select: { id: true, name: true, photoPath: true, idCardPath: true },
  });
}

export function setDocPath(id: string, field: 'photoPath' | 'idCardPath', path: string | null) {
  return prisma.driver.update({
    where: { id },
    select: { id: true, photoPath: true, idCardPath: true },
    data: { [field]: path },
  });
}
