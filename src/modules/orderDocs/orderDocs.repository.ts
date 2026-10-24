import type { OrderDocumentKind, PodLeg, Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma.js';

/** All Prisma access for an order's documents and their signatures. */

/** A document always travels with its signatures — the console shows both. */
export const docInclude = {
  signatures: { orderBy: { capturedAt: 'asc' } },
} satisfies Prisma.OrderDocumentInclude;

export type DocumentWithSignatures = Prisma.OrderDocumentGetPayload<{
  include: typeof docInclude;
}>;

export function consignmentExists(id: string) {
  return prisma.consignment.findUnique({ where: { id }, select: { id: true, driverId: true } });
}

export function listForConsignment(consignmentId: string) {
  return prisma.orderDocument.findMany({
    where: { consignmentId },
    include: docInclude,
    orderBy: { kind: 'asc' },
  });
}

export function findByKind(consignmentId: string, kind: OrderDocumentKind) {
  return prisma.orderDocument.findUnique({
    where: { consignmentId_kind: { consignmentId, kind } },
    include: docInclude,
  });
}

/**
 * Create the document or replace its file in place.
 *
 * An upsert rather than delete-then-insert, so replacing a letter keeps the row
 * id, keeps the flags the operator already configured, and keeps any signature
 * already collected — re-uploading a clearer scan of the same BOL must not throw
 * away a signature taken at the dock.
 */
export function upsertDoc(
  consignmentId: string,
  kind: OrderDocumentKind,
  file: { path: string; mime: string; bytes: number },
  uploadedByUserId: string | null,
) {
  return prisma.orderDocument.upsert({
    where: { consignmentId_kind: { consignmentId, kind } },
    create: { consignmentId, kind, ...file, uploadedByUserId },
    update: { ...file, uploadedByUserId },
    include: docInclude,
  });
}

export function updateFlags(id: string, flags: Prisma.OrderDocumentUpdateInput) {
  return prisma.orderDocument.update({ where: { id }, data: flags, include: docInclude });
}

export function deleteDoc(id: string) {
  return prisma.orderDocument.delete({ where: { id }, include: docInclude });
}

export function createSignature(
  documentId: string,
  leg: PodLeg,
  file: { signaturePath: string; signatureMime: string; signatureBytes: number },
  capturedByDriverId: string | null,
  capturedByUserId: string | null,
) {
  return prisma.orderDocumentSignature.create({
    data: { documentId, leg, ...file, capturedByDriverId, capturedByUserId },
  });
}

export function setSignedCopy(
  id: string,
  signed: { signedPath: string; signedMime: string; signedBytes: number },
) {
  return prisma.orderDocumentSignature.update({ where: { id }, data: signed });
}

/**
 * The documents that must be signed at this leg and have no signature for it.
 *
 * This is the whole blocking rule, as one query. Empty means the leg's paperwork
 * is complete and proof capture may proceed.
 */
export function findRequiredUnsigned(consignmentId: string, leg: PodLeg) {
  return prisma.orderDocument.findMany({
    where: {
      consignmentId,
      ...(leg === 'PICKUP' ? { signAtPickup: true } : { signAtDelivery: true }),
      signatures: { none: { leg } },
    },
    select: { kind: true },
    orderBy: { kind: 'asc' },
  });
}
