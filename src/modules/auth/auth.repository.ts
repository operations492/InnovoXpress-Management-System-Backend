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
      avatarPath: true,
      driver: { select: { id: true, name: true, code: true, active: true, onShift: true } },
    },
  });
}

/**
 * Store where to push notifications for this person.
 *
 * A plain overwrite. The token is a delivery address the OS may rotate, not an
 * identity, so the newest one always wins and there is nothing to reconcile.
 */
/**
 * Point this person at a stored profile photo, or at none.
 *
 * A plain overwrite, with no interest in what was there before. The caller does
 * not need to be told: an avatar key is fully determined by the user id and the
 * file extension, so the handful of objects a person could possibly own is known
 * without reading anything, and the service clears the siblings directly. That
 * sidesteps a read-then-write race where two uploads both see the same old path
 * and the loser deletes the object the winner had just stored.
 */
export function setAvatarPath(id: string, avatarPath: string | null) {
  return prisma.user.update({
    where: { id },
    data: { avatarPath },
    select: { id: true },
  });
}

export function setPushToken(id: string, pushToken: string | null) {
  return prisma.user.update({
    where: { id },
    data: { pushToken },
    select: { id: true },
  });
}

