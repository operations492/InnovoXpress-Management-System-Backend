import type { PodLeg } from '@prisma/client';
import { POD_BUCKET, supabase } from '../../config/supabase.js';
import { env } from '../../config/env.js';
import { AppError } from '../../utils/httpError.js';

/**
 * Object paths are DETERMINISTIC: pod/{consignmentId}/{LEG}/photo.{ext}
 *
 * Not a random name per attempt. This is the decision that keeps storage clean:
 * a failed or abandoned upload leaves at most two stale objects per leg, which
 * the next successful attempt overwrites. With random names, every retry would
 * leave permanent garbage nobody can attribute to anything.
 *
 * The cost is that paths are guessable — which is precisely why the bucket is
 * private and reads go through short-lived signed URLs.
 */
export function objectPath(
  consignmentId: string,
  leg: PodLeg,
  kind: 'photo' | 'signature',
  ext: string,
): string {
  return `${consignmentId}/${leg}/${kind}.${ext}`;
}

export async function uploadObject(
  path: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  const { error } = await supabase.storage.from(POD_BUCKET).upload(path, body, {
    contentType,
    upsert: true,
  });

  if (error) {
    throw AppError.badRequest(`Could not store the proof file: ${error.message}`);
  }
}

/** Best-effort cleanup after a failed write. Never throws — the caller is already failing. */
export async function removeObjects(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  try {
    await supabase.storage.from(POD_BUCKET).remove(paths);
  } catch (e) {
    console.error('Failed to clean up orphaned proof objects', paths, e);
  }
}

/** A time-limited link. The bucket is private, so this is the only way to view a file. */
export async function signedUrl(path: string): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from(POD_BUCKET)
    .createSignedUrl(path, env.POD_SIGNED_URL_TTL);

  if (error || !data) {
    console.error('Failed to sign proof URL', path, error);
    return null;
  }
  return data.signedUrl;
}
