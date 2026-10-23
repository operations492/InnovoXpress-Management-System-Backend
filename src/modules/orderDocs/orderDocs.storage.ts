import { randomUUID } from 'node:crypto';
import { ORDER_DOCS_BUCKET, supabase } from '../../config/supabase.js';
import { env } from '../../config/env.js';
import { AppError } from '../../utils/httpError.js';

/**
 * Order documents and their signatures, in the private `order-docs` bucket.
 *
 * Moved here from `consignments.storage.ts` when the single release-letter column
 * became this module's child table. The bucket only ever held order paperwork, so
 * the code belongs to the feature that owns it rather than to consignments.
 *
 * Paths carry a RANDOM segment. POD paths are deterministic so that a retry
 * overwrites its own stale object; here a replacement is rare, the old object is
 * deleted explicitly, and a guessable path buys nothing.
 */
export function objectPath(consignmentId: string, slug: string, ext: string): string {
  return `${consignmentId}/${slug}-${randomUUID()}.${ext}`;
}

export async function uploadObject(
  path: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  const { error } = await supabase.storage.from(ORDER_DOCS_BUCKET).upload(path, body, {
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
    await supabase.storage.from(ORDER_DOCS_BUCKET).remove(paths);
  } catch (e) {
    console.error('Failed to clean up order documents', paths, e);
  }
}

/** A time-limited link. The bucket is private, so this is the only way to view a file. */
export async function signedUrl(path: string | null): Promise<string | null> {
  if (!path) return null;

  const { data, error } = await supabase.storage
    .from(ORDER_DOCS_BUCKET)
    .createSignedUrl(path, env.ORDER_DOCS_SIGNED_URL_TTL);

  if (error || !data) {
    console.error('Failed to sign order document URL', path, error);
    return null;
  }
  return data.signedUrl;
}

/**
 * The bytes themselves, needed to append a signature page to an existing
 * document. Returns null rather than throwing: failing to produce the stamped
 * copy must never cost us the signature that was already captured.
 */
export async function downloadObject(path: string): Promise<Buffer | null> {
  const { data, error } = await supabase.storage.from(ORDER_DOCS_BUCKET).download(path);

  if (error || !data) {
    console.error('Failed to download order document', path, error);
    return null;
  }
  return Buffer.from(await data.arrayBuffer());
}
