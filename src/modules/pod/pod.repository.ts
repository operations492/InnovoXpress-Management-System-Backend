import type { ConsignmentStatus, PodLeg } from '@prisma/client';
import { prisma } from '../../config/prisma.js';
import { AppError } from '../../utils/httpError.js';

/** All Prisma access for proof of delivery. */

export function findConsignmentForPod(id: string) {
  return prisma.consignment.findUnique({
    where: { id },
    select: { id: true, status: true, driverId: true },
  });
}

export function consignmentExists(id: string) {
  return prisma.consignment.findUnique({ where: { id }, select: { id: true } });
}

export function findProof(consignmentId: string, leg: PodLeg) {
  return prisma.proofOfDelivery.findUnique({
    where: { consignmentId_leg: { consignmentId, leg } },
  });
}

export function listProofs(consignmentId: string) {
  return prisma.proofOfDelivery.findMany({
    where: { consignmentId },
    include: { capturedByDriver: { select: { id: true, name: true } } },
    orderBy: { leg: 'asc' },
  });
}

export interface CaptureInput {
  consignmentId: string;
  leg: PodLeg;
  from: ConsignmentStatus;
  to: ConsignmentStatus;
  stamp: 'pickedUpAt' | 'deliveredAt';
  photo: { path: string; mime: string; bytes: number };
  signature: { path: string; mime: string; bytes: number };
  driverId: string;
  actorId: string;
  actorEmail: string;
  /** The person who signed for the handover. See the schema comment. */
  signedByName?: string;
  /** Pieces the driver counted, matching the order or not. See the schema comment. */
  itemCount?: number;
  note: string;
  idempotencyKey?: string;
}

/**
 * Advance the status, insert the proof and write the audit event as one unit.
 *
 * The status update is a compare-and-swap on the status that was read: if
 * anything moved the order in the meantime this matches zero rows and the whole
 * transaction rolls back, so a proof can never be recorded against a job that
 * has already moved on.
 *
 * The timeout is explicit because Prisma's 5s default is tight once the database
 * is a region away.
 */
export function captureProofTx(input: CaptureInput) {
  return prisma.$transaction(
    async (tx) => {
      /*
       * Where the driver is, copied onto the proof while it still means
       * something. `driver_positions` is overwritten within seconds and
       * `driver_locations` is pruned after a week, so a proof that does not keep
       * its own copy can never be placed on a map again.
       *
       * A primary-key lookup, and tolerant of a missing row: a driver whose
       * phone has never reported a position still gets to deliver.
       */
      const fix = await tx.driverPosition.findUnique({
        where: { driverId: input.driverId },
        select: { lat: true, lng: true, accuracyM: true, recordedAt: true },
      });

      const { count } = await tx.consignment.updateMany({
        where: { id: input.consignmentId, status: input.from },
        data: {
          status: input.to,
          [input.stamp]: new Date(),
          lastUpdatedByUserId: input.actorId,
        },
      });

      if (count !== 1) {
        throw AppError.conflict('The order changed while the proof was uploading, please retry');
      }

      await tx.proofOfDelivery.create({
        data: {
          consignmentId: input.consignmentId,
          leg: input.leg,
          photoPath: input.photo.path,
          photoMime: input.photo.mime,
          photoBytes: input.photo.bytes,
          signaturePath: input.signature.path,
          signatureMime: input.signature.mime,
          signatureBytes: input.signature.bytes,
          signedByName: input.signedByName ?? null,
          itemCount: input.itemCount ?? null,
          capturedByDriverId: input.driverId,
          capturedByUserId: input.actorId,
          podLat: fix?.lat ?? null,
          podLng: fix?.lng ?? null,
          podAccuracyM: fix?.accuracyM ?? null,
          podFixAt: fix?.recordedAt ?? null,
          idempotencyKey: input.idempotencyKey ?? null,
        },
      });

      await tx.trackingEvent.create({
        data: {
          consignmentId: input.consignmentId,
          fromStatus: input.from,
          toStatus: input.to,
          driverId: input.driverId,
          actorUserId: input.actorId,
          actorEmail: input.actorEmail,
          note: input.note,
        },
      });
    },
    { timeout: 15_000 },
  );
}

export function replaceProofFiles(
  consignmentId: string,
  leg: PodLeg,
  photo: { path: string; mime: string; bytes: number },
  signature: { path: string; mime: string; bytes: number },
  actorId: string,
) {
  return prisma.proofOfDelivery.update({
    where: { consignmentId_leg: { consignmentId, leg } },
    data: {
      photoPath: photo.path,
      photoMime: photo.mime,
      photoBytes: photo.bytes,
      signaturePath: signature.path,
      signatureMime: signature.mime,
      signatureBytes: signature.bytes,
      replacedAt: new Date(),
      capturedByUserId: actorId,
    },
  });
}
