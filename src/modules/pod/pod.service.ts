import { ConsignmentStatus, PodLeg, Prisma } from '@prisma/client';
import { env } from '../../config/env.js';
import { AppError } from '../../utils/httpError.js';
import { sniffImage } from '../../utils/imageSniff.js';
import { STATUS_LABELS } from '../../constants/enums.js';
import { canTransition } from '../../constants/statusFlow.js';
import type { PodBody } from '../../schemas/pod.schema.js';
import * as repo from './pod.repository.js';
import * as storage from './pod.storage.js';

export interface Actor {
  id: string;
  email: string;
}

export interface IncomingFile {
  buffer: Buffer;
  size: number;
}

/**
 * Each leg closes one half of the job, and each has exactly one status it may be
 * captured from. Capturing proof at the wrong moment is a 409, not a silent
 * overwrite.
 */
const LEG_RULES = {
  [PodLeg.PICKUP]: {
    from: ConsignmentStatus.AT_PICKUP,
    to: ConsignmentStatus.PICKED_UP,
    stamp: 'pickedUpAt' as const,
    label: 'pickup',
  },
  [PodLeg.DELIVERY]: {
    from: ConsignmentStatus.AT_DELIVERY,
    to: ConsignmentStatus.DELIVERED,
    stamp: 'deliveredAt' as const,
    label: 'delivery',
  },
};

function validateImage(
  file: IncomingFile | undefined,
  field: 'photo' | 'signature',
  maxBytes: number,
) {
  if (!file) throw AppError.badRequest(`A ${field} is required`);
  if (file.size === 0) throw AppError.badRequest(`The ${field} file is empty`);
  if (file.size > maxBytes) {
    throw new AppError(
      413,
      'PAYLOAD_TOO_LARGE',
      `The ${field} is ${(file.size / 1_048_576).toFixed(1)}MB, over the ${(
        maxBytes / 1_048_576
      ).toFixed(1)}MB limit`,
    );
  }

  const sniffed = sniffImage(file.buffer);
  if (!sniffed) {
    throw AppError.badRequest(
      `The ${field} is not a JPEG, PNG or WebP image (its actual contents were checked, not its declared type)`,
    );
  }
  return sniffed;
}

/**
 * Capture proof for one leg and, in the same breath, advance the order.
 *
 * Ordering is deliberate:
 *   1. validate in memory      — cheap rejects before any network cost
 *   2. pre-flight read         — wrong status / already captured fails here
 *   3. upload both files       — storage first, so a proof row can never point
 *                                at bytes that were never written
 *   4. one transaction         — CAS the status, insert the proof, write the
 *                                audit event; all three or none
 *   5. compensate on failure   — best-effort delete of the just-written objects
 *
 * Doing it the other way round (row first, upload second) would allow an order
 * marked DELIVERED whose proof file does not exist. That is the exact failure
 * this feature exists to prevent.
 */
export async function captureProof(
  consignmentId: string,
  leg: PodLeg,
  files: { photo?: IncomingFile; signature?: IncomingFile },
  body: PodBody,
  actor: Actor,
  idempotencyKey?: string,
) {
  const rule = LEG_RULES[leg];

  const photo = validateImage(files.photo, 'photo', env.POD_MAX_PHOTO_BYTES);
  const signature = validateImage(files.signature, 'signature', env.POD_MAX_SIGNATURE_BYTES);

  const consignment = await repo.findConsignmentForPod(consignmentId);
  if (!consignment) throw AppError.notFound('Consignment not found');

  const existingProof = await repo.findProof(consignmentId, leg);

  if (existingProof) {
    // A retry of a request whose response was lost should not look like a
    // conflict — that is the normal case on a phone with poor signal.
    if (idempotencyKey && existingProof.idempotencyKey === idempotencyKey) {
      return { proof: await getProofs(consignmentId), replayed: true };
    }
    throw AppError.conflict(`The ${rule.label} proof has already been captured`);
  }

  if (consignment.status !== rule.from) {
    throw AppError.conflict(
      `${rule.label === 'pickup' ? 'Pickup' : 'Delivery'} proof can only be captured when the order is ` +
        `${STATUS_LABELS[rule.from]} — it is currently ${STATUS_LABELS[consignment.status]}`,
    );
  }

  if (!consignment.driverId) {
    throw AppError.conflict('The order has no driver, so nobody can capture proof for it');
  }

  if (!canTransition(consignment.status, rule.to, 'POD')) {
    throw AppError.conflict('That status change is not allowed');
  }

  const photoPath = storage.objectPath(consignmentId, leg, 'photo', photo.ext);
  const signaturePath = storage.objectPath(consignmentId, leg, 'signature', signature.ext);

  await storage.uploadObject(photoPath, files.photo!.buffer, photo.mime);
  try {
    await storage.uploadObject(signaturePath, files.signature!.buffer, signature.mime);
  } catch (e) {
    await storage.removeObjects([photoPath]);
    throw e;
  }

  try {
    await repo.captureProofTx({
      consignmentId,
      leg,
      from: rule.from,
      to: rule.to,
      stamp: rule.stamp,
      photo: { path: photoPath, mime: photo.mime, bytes: files.photo!.size },
      signature: { path: signaturePath, mime: signature.mime, bytes: files.signature!.size },
      signedByName: body.signedByName,
      driverId: body.capturedByDriverId ?? consignment.driverId,
      actorId: actor.id,
      actorEmail: actor.email,
      note: body.note ?? `${rule.label === 'pickup' ? 'Pickup' : 'Delivery'} proof captured`,
      idempotencyKey,
    });
  } catch (e) {
    // The status did not move, so these two objects belong to nothing.
    await storage.removeObjects([photoPath, signaturePath]);

    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === 'P2002' &&
      idempotencyKey
    ) {
      const raced = await repo.findProof(consignmentId, leg);
      if (raced?.idempotencyKey === idempotencyKey) {
        return { proof: await getProofs(consignmentId), replayed: true };
      }
    }
    throw e;
  }

  return { proof: await getProofs(consignmentId), replayed: false };
}

/** Both legs with time-limited links. Capturing proof nobody can retrieve is pointless. */
export async function getProofs(consignmentId: string) {
  const consignment = await repo.consignmentExists(consignmentId);
  if (!consignment) throw AppError.notFound('Consignment not found');

  const proofs = await repo.listProofs(consignmentId);

  return Promise.all(
    proofs.map(async (p) => ({
      leg: p.leg,
      capturedAt: p.capturedAt,
      signedByName: p.signedByName,
      capturedByDriver: p.capturedByDriver,
      photo: {
        mime: p.photoMime,
        bytes: p.photoBytes,
        url: await storage.signedUrl(p.photoPath),
      },
      signature: {
        mime: p.signatureMime,
        bytes: p.signatureBytes,
        url: await storage.signedUrl(p.signaturePath),
      },
      replacedAt: p.replacedAt,
      expiresInSeconds: env.POD_SIGNED_URL_TTL,
    })),
  );
}

/**
 * Replace the files on an existing proof — a blurry photo, a mis-tapped
 * signature. Admin only.
 *
 * Overwrites the objects and updates the metadata, but deliberately does NOT
 * touch the status and does NOT insert a second proof row: the chain stays
 * forward-only and the one-proof-per-leg rule holds. Without this, the absence
 * of any exception state would make a bad photo permanently unfixable.
 */
export async function replaceProofFiles(
  consignmentId: string,
  leg: PodLeg,
  files: { photo?: IncomingFile; signature?: IncomingFile },
  actor: Actor,
) {
  const existing = await repo.findProof(consignmentId, leg);
  if (!existing) throw AppError.notFound('No proof has been captured for this leg');

  const photo = validateImage(files.photo, 'photo', env.POD_MAX_PHOTO_BYTES);
  const signature = validateImage(files.signature, 'signature', env.POD_MAX_SIGNATURE_BYTES);

  const photoPath = storage.objectPath(consignmentId, leg, 'photo', photo.ext);
  const signaturePath = storage.objectPath(consignmentId, leg, 'signature', signature.ext);

  await storage.uploadObject(photoPath, files.photo!.buffer, photo.mime);
  await storage.uploadObject(signaturePath, files.signature!.buffer, signature.mime);

  await repo.replaceProofFiles(
    consignmentId,
    leg,
    { path: photoPath, mime: photo.mime, bytes: files.photo!.size },
    { path: signaturePath, mime: signature.mime, bytes: files.signature!.size },
    actor.id,
  );

  return getProofs(consignmentId);
}
