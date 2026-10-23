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
 * One driver document per request, field name `file`.
 *
 * The Content-Type filter is a cheap early reject only — it is client-supplied.
 * The service sniffs the real bytes with `sniffImage` before anything is stored,
 * exactly as POD does.
 */
export const uploadDriverDoc = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fields: 0, fileSize: env.DRIVER_DOCS_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpeg|png|webp)$/.test(file.mimetype)) return cb(null, true);
    cb(null, false);
  },
}).single('file');

/**
 * One release letter per request, field name `file`.
 *
 * PDFs are allowed here and nowhere else — a release letter is normally a scanned
 * or emailed PDF, while POD must stay image-only. As everywhere, the declared
 * Content-Type is a cheap early reject; the service sniffs the real bytes.
 */
/**
 * One document signature per request, field name `signature`.
 *
 * PNG or JPEG only — NOT WebP, unlike POD. These are embedded into the signed
 * PDF copy and `pdf-lib` embeds neither WebP nor anything else, so accepting one
 * would mean storing a signature that could never appear on its own document.
 */
export const uploadDocSignature = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fields: 0, fileSize: env.POD_MAX_SIGNATURE_BYTES },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpeg|png)$/.test(file.mimetype)) return cb(null, true);
    cb(null, false);
  },
}).single('signature');

export const uploadOrderDoc = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fields: 0, fileSize: env.ORDER_DOCS_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    if (/^(image\/(jpeg|png|webp)|application\/pdf)$/.test(file.mimetype)) return cb(null, true);
    cb(null, false);
  },
}).single('file');
