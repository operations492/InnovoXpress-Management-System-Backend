import { randomUUID } from 'node:crypto';
import { DRIVER_DOCS_BUCKET, supabase } from '../config/supabase.js';
import { env } from '../config/env.js';
import { AppError } from './httpError.js';

/**
 * A driver's photo and ID card, in the private `driver-docs` bucket.
 *
 * This lives in `utils/` rather than inside the drivers module because `map`
 * needs to sign a photo URL for the dispatch map too, and `map.service` reaching
 * into a drivers-module storage file would add another cross-module leak for no
 * benefit.
 *
 * Unlike POD, paths carry a RANDOM segment. POD paths are deterministic so that a
 * retry overwrites its own stale object; here a replacement is rare, the old
 * object is deleted explicitly, and a guessable path buys nothing.
 */
export type DriverDocKind = 'photo' | 'id-card';

export function objectPath(driverId: string, kind: DriverDocKind, ext: string): string {
  return `${driverId}/${kind}-${randomUUID()}.${ext}`;
}

export async function uploadObject(
  path: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  const { error } = await supabase.storage.from(DRIVER_DOCS_BUCKET).upload(path, body, {
    contentType,
    upsert: true,
  });

  if (error) {
    throw AppError.badRequest(`Could not store the file: ${error.message}`);
  }
}

/** Best-effort cleanup. Never throws — the caller is either failing or replacing. */
export async function removeObjects(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  try {
    await supabase.storage.from(DRIVER_DOCS_BUCKET).remove(paths);
  } catch (e) {
    console.error('Failed to clean up driver documents', paths, e);
  }
}

/** A time-limited link. The bucket is private, so this is the only way to view a file. */
export async function signedUrl(path: string | null): Promise<string | null> {
  if (!path) return null;

  const { data, error } = await supabase.storage
    .from(DRIVER_DOCS_BUCKET)
    .createSignedUrl(path, env.DRIVER_DOCS_SIGNED_URL_TTL);

  if (error || !data) {
    console.error('Failed to sign driver document URL', path, error);
    return null;
  }
  return data.signedUrl;
}
