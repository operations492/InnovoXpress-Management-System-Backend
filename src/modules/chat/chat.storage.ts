import { randomUUID } from 'node:crypto';
import { supabase, CHAT_BUCKET } from '../../config/supabase.js';
import { env } from '../../config/env.js';
import { AppError } from '../../utils/httpError.js';
import { sniffImage } from '../../utils/imageSniff.js';

/**
 * Chat attachments in Supabase Storage.
 *
 * Modelled on pod.storage.ts but deliberately its own module and its own
 * bucket: POD accepts images only because a signature must be an image, while
 * chat accepts anything. One shared module would mean one place to loosen the
 * rule by accident.
 *
 * The security model is Google Chat's, not a whitelist:
 *   - the bucket is PRIVATE, and reads go through short-lived signed URLs;
 *   - Storage is served from a different origin than the console, so nothing
 *     a file could do reaches our session or DOM;
 *   - everything downloads rather than renders, EXCEPT files whose magic bytes
 *     really say PNG/JPEG/WebP.
 *
 * That last rule is what stops the classic SVG trap — a genuine image which is
 * also an executable script.
 */

/** Kept in sync with the bucket's own file_size_limit. */
export const MAX_FILE_BYTES = env.CHAT_MAX_FILE_BYTES;

export interface StoredAttachment {
  path: string;
  name: string;
  mime: string;
  bytes: number;
  isImage: boolean;
}

/**
 * A filename is attacker-controlled, so it never touches the storage path —
 * the object is keyed by a uuid and the name is kept in the database for
 * display and for Content-Disposition. This also removes any question of
 * traversal, unicode tricks or case collisions in the bucket.
 */
function safeName(raw: string | undefined): string {
  const base = (raw ?? 'file').split(/[\\/]/).pop() ?? 'file';
  const cleaned = base
    // Control characters and quotes would let a name forge header syntax.
    .replace(/[\u0000-\u001f\u007f"\\]/g, '')
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, 200) : 'file';
}

export function attachmentPath(conversationId: string): string {
  return `${conversationId}/${randomUUID()}`;
}

/**
 * Upload before the message row is written — the same ordering rule POD uses.
 * Row-first would allow a message that points at a file which was never
 * stored, which is the exact failure this feature must not have.
 */
export async function uploadAttachment(params: {
  conversationId: string;
  file: { buffer: Buffer; originalname?: string; mimetype?: string; size: number };
}): Promise<StoredAttachment> {
  const { conversationId, file } = params;

  if (file.size > MAX_FILE_BYTES) {
    throw AppError.badRequest(
      `That file is larger than the ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB limit`,
    );
  }
  if (file.size === 0) throw AppError.badRequest('That file is empty');

  // Sniffing decides how the file may be SERVED, not whether it is accepted.
  // Content-Type is client-supplied and trivially forged, so it is never
  // trusted for anything that matters.
  const sniffed = sniffImage(file.buffer);
  const isImage = sniffed !== null;
  const mime = sniffed?.mime ?? 'application/octet-stream';

  const path = attachmentPath(conversationId);

  const { error } = await supabase.storage.from(CHAT_BUCKET).upload(path, file.buffer, {
    contentType: mime,
    upsert: false,
  });
  if (error) {
    throw AppError.badRequest(`Could not store the file: ${error.message}`);
  }

  return {
    path,
    name: safeName(file.originalname),
    mime,
    bytes: file.size,
    isImage,
  };
}

/** Best-effort cleanup when the surrounding transaction fails. */
export async function removeAttachment(path: string): Promise<void> {
  try {
    await supabase.storage.from(CHAT_BUCKET).remove([path]);
  } catch {
    // An orphaned object is untidy; a thrown error here would mask the real
    // failure the caller is already handling.
  }
}

export interface AttachmentLinks {
  downloadUrl: string;
  /** Only ever set for verified images — everything else is download-only. */
  previewUrl: string | null;
  expiresInSeconds: number;
}

/**
 * Mint links on demand rather than storing them on the message.
 *
 * Signed URLs expire, so embedding one in the message DTO would make the REST
 * response and the Realtime broadcast payload disagree — they are asserted to
 * be identical, and the client relies on that to parse both with one function.
 */
export async function signAttachment(attachment: {
  path: string;
  name: string;
  isImage: boolean;
}): Promise<AttachmentLinks> {
  const ttl = env.CHAT_SIGNED_URL_TTL;
  const bucket = supabase.storage.from(CHAT_BUCKET);

  // `download` sets Content-Disposition: attachment, so the browser saves the
  // file instead of rendering it. This is what makes accepting arbitrary
  // file types safe.
  const { data, error } = await bucket.createSignedUrl(attachment.path, ttl, {
    download: attachment.name,
  });
  if (error || !data?.signedUrl) {
    throw AppError.badRequest(`Could not create a download link: ${error?.message ?? 'unknown'}`);
  }

  let previewUrl: string | null = null;
  if (attachment.isImage) {
    const preview = await bucket.createSignedUrl(attachment.path, ttl);
    previewUrl = preview.data?.signedUrl ?? null;
  }

  return { downloadUrl: data.signedUrl, previewUrl, expiresInSeconds: ttl };
}
