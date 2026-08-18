import { Prisma, type UserRole } from '@prisma/client';
import { prisma } from '../../config/prisma.js';

/** All Prisma access for user administration. */

const listSelect = {
  id: true,
  email: true,
  name: true,
  role: true,
  active: true,
  driverId: true,
  createdAt: true,
  driver: { select: { id: true, name: true, code: true, active: true, onShift: true } },
} satisfies Prisma.UserSelect;

export type UserRow = Prisma.UserGetPayload<{ select: typeof listSelect }>;

export function listUsers(params: { role?: UserRole; q?: string; includeInactive: boolean }) {
  const where: Prisma.UserWhereInput = {};
  if (params.role) where.role = params.role;
  if (!params.includeInactive) where.active = true;
  if (params.q) {
    where.OR = [
      { name: { contains: params.q, mode: 'insensitive' } },
      { email: { contains: params.q, mode: 'insensitive' } },
    ];
  }

  return prisma.user.findMany({
    where,
    select: listSelect,
    orderBy: [{ role: 'desc' }, { name: 'asc' }],
  });
}

export function findById(id: string) {
  return prisma.user.findUnique({ where: { id }, select: listSelect });
}

export function findByEmail(email: string) {
  return prisma.user.findUnique({ where: { email }, select: listSelect });
}

export function createProfile(data: {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  driverId: string | null;
}) {
  return prisma.user.create({ data, select: listSelect });
}

export function updateProfile(
  id: string,
  data: { email?: string; name?: string; role?: UserRole; active?: boolean },
) {
  return prisma.user.update({ where: { id }, data, select: listSelect });
}

export function deleteProfile(id: string) {
  return prisma.user.delete({ where: { id } });
}

/** How many admins could still log in — the last one must never be removable. */
export function countActiveAdmins() {
  return prisma.user.count({ where: { role: 'admin', active: true } });
}

/* ------------------------------------------------------------------ */
/* drivers                                                             */
/* ------------------------------------------------------------------ */

export function findDriverById(id: string) {
  return prisma.driver.findUnique({
    where: { id },
    select: { id: true, name: true, code: true, active: true, user: { select: { id: true } } },
  });
}

export function createDriver(data: {
  name: string;
  code?: string;
  mobile?: string;
  mapColorIndex?: number;
}) {
  return prisma.driver.create({ data, select: { id: true, name: true, code: true } });
}

export function deleteDriver(id: string) {
  return prisma.driver.delete({ where: { id } });
}

/** Roster drivers with no login yet — what the create form offers to link. */
export function findUnlinkedDrivers() {
  return prisma.driver.findMany({
    where: { active: true, user: null },
    select: { id: true, name: true, code: true, mobile: true },
    orderBy: { name: 'asc' },
  });
}

/**
 * Whether a driver carries history. A driver who has ever been assigned a job,
 * or captured proof, must be deactivated rather than deleted — otherwise the
 * record of who delivered what disappears.
 */
export async function driverFootprint(driverId: string) {
  const [consignments, proofs] = await Promise.all([
    prisma.consignment.count({ where: { driverId } }),
    prisma.proofOfDelivery.count({ where: { capturedByDriverId: driverId } }),
  ]);
  return { consignments, proofs };
}

export async function setDriverActive(id: string, active: boolean) {
  if (active) return prisma.driver.update({ where: { id }, data: { active: true } });

  // Someone who has left is not on shift either — but the close time is stamped
  // only if a shift was genuinely open. A blind write would overwrite the real
  // end of their last shift with the moment an admin got round to the paperwork,
  // which could be weeks later.
  const [, driver] = await prisma.$transaction([
    prisma.driver.updateMany({
      where: { id, onShift: true },
      data: { onShift: false, shiftEndedAt: new Date() },
    }),
    prisma.driver.update({ where: { id }, data: { active: false, onShift: false } }),
  ]);
  return driver;
}

export type ShiftRow = {
  id: string;
  name: string;
  onShift: boolean;
  shiftStartedAt: Date | null;
  shiftEndedAt: Date | null;
};

/**
 * Clock a driver on or off.
 *
 * Raw SQL rather than `prisma.driver.update` because both timestamps depend on
 * the row's *current* `onShift`, which Prisma cannot express in a data payload —
 * and reading it first would leave a gap where two taps from a flaky phone
 * interleave.
 *
 * The rules, in one statement:
 *   - clocking on   → start = now, end = null (the shift is open)
 *   - clocking off  → end = now, start untouched (the pair is the shift's window)
 *   - tapping the button you are already on → nothing moves, so a retry after a
 *     lost response is harmless and cannot stretch or truncate the shift
 *
 * `updatedAt` is set by hand: raw SQL bypasses Prisma's `@updatedAt`.
 */
export async function setShift(driverId: string, onShift: boolean): Promise<ShiftRow | null> {
  const rows = await prisma.$queryRaw<ShiftRow[]>`
    UPDATE drivers
    SET "onShift" = ${onShift},
        "shiftStartedAt" = CASE
          WHEN ${onShift} AND NOT "onShift" THEN now() AT TIME ZONE 'utc'
          ELSE "shiftStartedAt"
        END,
        "shiftEndedAt" = CASE
          WHEN ${onShift} THEN NULL
          WHEN "onShift" THEN now() AT TIME ZONE 'utc'
          ELSE "shiftEndedAt"
        END,
        "updatedAt" = now() AT TIME ZONE 'utc'
    WHERE id = ${driverId}
    RETURNING id, name, "onShift", "shiftStartedAt", "shiftEndedAt"
  `;
  return rows[0] ?? null;
}
