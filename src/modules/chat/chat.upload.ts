import multer from 'multer';
import { env } from '../../config/env.js';

/**
 * One file per chat message, of any type.
 *
 * Deliberately NOT `middleware/upload.ts`. That instance is hardcoded to POD's
 * `photo` + `signature` fields and filters to images, because a
 * proof-of-delivery signature must be an image. Widening it to serve chat
 * would loosen an evidence rule for an unrelated feature.
 *
 * There is no `fileFilter` here on purpose: chat accepts anything. Safety
 * comes from the read path — a private bucket, short-lived signed URLs, and
 * Content-Disposition: attachment on everything that is not a verified image.
 *
 * `fileSize` is the same 5 MB the bucket and a CHECK constraint enforce, so
 * the limit holds even if this middleware were bypassed.
 */
export const uploadChatFile = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 1,
    fields: 4,
    fileSize: env.CHAT_MAX_FILE_BYTES,
  },
}).single('file');
