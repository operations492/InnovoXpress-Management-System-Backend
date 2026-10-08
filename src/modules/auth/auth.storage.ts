import { AVATAR_BUCKET, supabase } from '../../config/supabase.js';
import { env } from '../../config/env.js';
import { AppError } from '../../utils/httpError.js';

/**
 * Profile photos in Supabase Storage.
 *
 * Deliberately a near-copy of pod.storage.ts rather than a shared abstraction.
 * The two have the same four operations today and completely different rules —
 * proof images are evidence, are never replaced once captured, and are emptied
 * by the seed script; a profile photo is replaced whenever the person feels like
 * it and belongs to nobody's audit trail. Folding them together would mean one
 * module whose every function needs to know which caller it is serving.
 */

/**
 * One object per person, named by the extension of whatever they uploaded.
 *
 * Keyed by user id and nothing else, so a person has at most one photo and
 * re-uploading overwrites rather than accumulating. The extension is in the name
 * because Storage serves the object with a content type derived from it, and a
 * PNG served as a JPEG renders as a broken image in some webviews.
 *
 * That does mean switching formats leaves the previous object behind — a PNG
 * upload after a JPEG writes `avatar.png` beside `avatar.jpg`. The service
 * deletes the old key after the new one is stored; see `setAvatar`.
 */
export function objectPath(userId: string, ext: string): string {
  return `${userId}/avatar.${ext}`;
}

export async function uploadObject(path: string, body: Buffer, contentType: string): Promise<void> {
  const { error } = await supabase.storage.from(AVATAR_BUCKET).upload(path, body, {
    contentType,
    // A retry after a dropped response must not fail as "already exists".
    upsert: true,
  });

  if (error) {
    throw AppError.badRequest(`Could not store the profile photo: ${error.message}`);
  }
}

/**
 * Best-effort removal. Never throws.
 *
 * A failure here leaves an orphaned object in a private bucket — invisible,
 * costing a few kilobytes. Propagating it would instead fail an upload that has
 * already succeeded, or a deletion the user has already been told about, which
 * is a far worse trade.
 */
export async function removeObjects(paths: string[]): Promise<void> {
  if (paths.length === 0) return;

  const { error } = await supabase.storage.from(AVATAR_BUCKET).remove(paths);
  if (error) console.warn(`[avatar] could not remove ${paths.join(', ')}: ${error.message}`);
}

/**
 * A readable link, good for an hour.
 *
 * Longer than POD's five minutes on purpose. A proof image is opened once, from
 * a screen that just fetched it; an avatar is rendered on every list row and
 * cached by the client, so a five-minute URL would have the driver app
 * re-fetching `me` purely to keep a face on screen.
 *
 * Returns null rather than throwing — a missing photo must never be the reason
 * a profile fails to load.
 */
export async function signedUrl(path: string): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from(AVATAR_BUCKET)
    .createSignedUrl(path, env.AVATAR_SIGNED_URL_TTL);

  if (error) {
    console.error(`[avatar] could not sign ${path}: ${error.message}`);
    return null;
  }

  return data.signedUrl;
}
