import multer from 'multer';
import { env } from '../config/env.js';

/**
 * Buffers the two proof files in memory — they are small, short-lived, and go
 * straight to Supabase Storage, so writing them to disk first would only create
 * temp files nobody cleans up.
 *
 * `fileSize` is the larger of the two limits because multer applies one limit
 * across all fields; the per-field limit is enforced afterwards in the service,
 * where we know which field is which.
 */
export const uploadPodFiles = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 2,
    fields: 4,
    fileSize: Math.max(env.POD_MAX_PHOTO_BYTES, env.POD_MAX_SIGNATURE_BYTES),
  },
  fileFilter: (_req, file, cb) => {
    // A fast, cheap reject on the declared Content-Type. This is NOT the real
    // check — the header is client-supplied and trivially forged, so the service
    // sniffs the actual bytes before anything is stored.
    if (/^image\/(jpeg|png|webp)$/.test(file.mimetype)) return cb(null, true);
    cb(null, false);
  },
}).fields([
  { name: 'photo', maxCount: 1 },
  { name: 'signature', maxCount: 1 },
]);

export type UploadedFiles = Record<string, Express.Multer.File[] | undefined>;

/**
 * One profile photo, on the `photo` field.
 *
 * `.single()` rather than `.fields()` because there is exactly one file and no
 * text alongside it — `fields: 0` makes that explicit, so a client trying to
 * smuggle extra form data gets rejected by multer rather than silently ignored.
 *
 * The same caveat applies as above: this filter trusts the declared
 * Content-Type, which is client-supplied. The service sniffs the actual bytes
 * before anything is stored.
 */
export const uploadAvatarFile = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fields: 0, fileSize: env.AVATAR_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpeg|png|webp)$/.test(file.mimetype)) return cb(null, true);
    cb(null, false);
  },
}).single('photo');
