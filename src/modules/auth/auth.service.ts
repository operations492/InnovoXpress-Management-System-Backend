import * as repo from './auth.repository.js';
import * as storage from './auth.storage.js';
import { AppError } from '../../utils/httpError.js';
import { sniffImage } from '../../utils/imageSniff.js';

/** Every extension an avatar can be stored under — see `clearSiblings`. */
const AVATAR_EXTENSIONS = ['png', 'jpg', 'webp'] as const;

/**
 * Delete the other formats this person might have had.
 *
 * Switching from a JPEG to a PNG writes a new key beside the old one rather than
 * replacing it, because the extension is part of the name. Rather than remember
 * the previous path and race against a concurrent upload, this just removes
 * every key the person could own except the one that was kept — the set is tiny
 * and completely determined by the user id.
 *
 * Best-effort, like the removal underneath it: an orphan is a few kilobytes in a
 * private bucket, and must never fail an upload that has already succeeded.
 */
async function clearSiblings(userId: string, keepPath: string | null) {
  const stale = AVATAR_EXTENSIONS.map((ext) => storage.objectPath(userId, ext)).filter(
    (path) => path !== keepPath,
  );
  await storage.removeObjects(stale);
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
    avatarUrl: user.avatarPath ? await storage.signedUrl(user.avatarPath) : null,
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
export async function setAvatar(userId: string, file: { buffer: Buffer }) {
  const sniffed = sniffImage(file.buffer);
  if (!sniffed) {
    throw AppError.badRequest(
      'That file is not a JPEG, PNG or WebP image (its actual contents were checked, not its declared type)',
    );
  }

  const path = storage.objectPath(userId, sniffed.ext);
  await storage.uploadObject(path, file.buffer, sniffed.mime);
  await repo.setAvatarPath(userId, path);

  // Only after the row points at the new object — a crash before this leaves an
  // unreferenced file, which is harmless; doing it first could delete the photo
  // still in use.
  await clearSiblings(userId, path);

  return { avatarUrl: await storage.signedUrl(path) };
}

/**
 * Remove this person's profile photo.
 *
 * The row is cleared before the objects, so a failure midway leaves files with
 * nothing pointing at them rather than a path pointing at nothing — the first is
 * invisible, the second is a broken image on every screen that shows them.
 */
export async function removeAvatar(userId: string) {
  await repo.setAvatarPath(userId, null);
  await clearSiblings(userId, null);
}
