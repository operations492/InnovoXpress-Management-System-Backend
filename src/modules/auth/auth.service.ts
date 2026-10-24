import * as repo from './auth.repository.js';
import { AppError } from '../../utils/httpError.js';
import { signedUrl } from '../../utils/driverDocs.js';
// The driver's photo is a roster document, owned by the drivers module. This
// module only exposes it to the person it belongs to; storage rules stay there.
import * as driversService from '../drivers/drivers.service.js';

/**
 * A driver's profile picture is `drivers.photoPath`, not a separate avatar.
 *
 * There were briefly two: this module stored one in an `avatars` bucket for the
 * phone, while the console stored another beside the driver's ID card in
 * `driver-docs`. Same face, two columns, two buckets — a driver changed their
 * picture in the app and the console kept showing the old one. The console's is
 * the one that survives, because it is the one an admin manages alongside the
 * rest of the roster record.
 *
 * The endpoints here did not change shape: `/me` still answers `avatarUrl` and
 * `POST /avatar` still takes one file, so the driver app needed no change at
 * all. Only what they read and write underneath moved.
 */
function driverIdOrRefuse(driverId: string | null): string {
  if (!driverId) {
    throw AppError.forbidden('Only a driver account has a profile picture');
  }
  return driverId;
}

/**
 * What is left of authentication on this side.
 *
 * Logging in happens against Supabase Auth directly from the client, which is
 * why there is no `login` here any more — and no bcrypt, no token signing, no
 * refresh handling. This backend only ever VERIFIES a token (see
 * middleware/auth.ts) and answers "who am I".
 */
export async function me(userId: string) {
  const user = await repo.findProfileWithDriver(userId);
  if (!user) throw AppError.unauthorized();

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    active: user.active,
    /**
     * A readable link to the profile photo, or null.
     *
     * Minted on every read rather than stored, because the bucket is private and
     * a signed URL expires. Clients treat it as disposable: render it, and fall
     * back to initials if it fails to load.
     *
     * A signing failure degrades to null instead of throwing — not being able to
     * show a face is never a reason to fail "who am I", which gates the whole
     * app behind it.
     */
    avatarUrl: await signedUrl(user.driver?.photoPath ?? null),
    /** Present only for drivers — what the phone needs to show its own state. */
    driver: user.driver
      ? {
          id: user.driver.id,
          name: user.driver.name,
          code: user.driver.code,
          active: user.driver.active,
          onShift: user.driver.onShift,
        }
      : null,
  };
}

/**
 * Register (or clear) this session's push token.
 *
 * Clearing is a real operation, not an oversight: the app posts `null` on sign
 * out, so a shared or handed-over phone stops receiving the previous driver's
 * jobs the moment they leave.
 */
export async function setPushToken(userId: string, pushToken: string | null) {
  await repo.setPushToken(userId, pushToken);
}

/**
 * Store a new profile photo and return a link to it.
 *
 * Order matters, and it is the opposite of proof-of-delivery's. POD writes the
 * file first because a row pointing at a missing object would be a hole in the
 * evidence; here the file is written first for a plainer reason — if the upload
 * fails, the person keeps the photo they already had, and nothing has changed.
 *
 * The declared Content-Type has already been checked by multer, and is not
 * trusted: the bytes are sniffed here, exactly as POD does, because the header
 * is client-supplied and trivially forged. A caller could otherwise have the
 * bucket serve arbitrary content under an image name.
 */
export async function setAvatar(userId: string, file: Express.Multer.File) {
  const user = await repo.findUserById(userId);
  if (!user) throw AppError.unauthorized();

  // Delegated, not reimplemented: sniffing, the object path, replacing the
  // previous file and signing the result are the drivers module's rules, and a
  // second copy of them here is how the two ended up disagreeing before.
  const docs = await driversService.putDriverDocument(
    driverIdOrRefuse(user.driverId),
    'photo',
    file,
  );

  return { avatarUrl: docs.photoUrl };
}

/** Take the profile picture down. The ID card beside it is untouched. */
export async function removeAvatar(userId: string) {
  const user = await repo.findUserById(userId);
  if (!user) throw AppError.unauthorized();

  await driversService.removeDriverDocument(driverIdOrRefuse(user.driverId), 'photo');
}
