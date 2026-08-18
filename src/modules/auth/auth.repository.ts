import { prisma } from '../../config/prisma.js';

/**
 * All Prisma access for authentication.
 *
 * There is no longer a lookup by email or a last-login stamp: Supabase Auth
 * owns credentials and records `last_sign_in_at` itself. What remains is
 * resolving a verified token's subject to the profile that says what they may
 * do.
 */

export function findUserById(id: string) {
  return prisma.user.findUnique({
    where: { id },
    select: { id: true, email: true, name: true, role: true, active: true, driverId: true },
  });
}

/** The `/me` payload — includes the driver's name so the phone can greet them. */
export function findProfileWithDriver(id: string) {
  return prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      active: true,
      driverId: true,
      driver: { select: { id: true, name: true, code: true, active: true, onShift: true } },
    },
  });
}
