import { OrderDocumentKind, PodLeg } from '@prisma/client';
import { AppError } from '../../utils/httpError.js';
import { sniffImage, sniffPdf } from '../../utils/imageSniff.js';
import type { DocFlagsInput } from '../../schemas/orderDoc.schema.js';
import * as repo from './orderDocs.repository.js';
import * as storage from './orderDocs.storage.js';
import { stampSigned } from './orderDocs.stamp.js';

/**
 * An order's paperwork: a release letter, a bill of lading, or both, each
 * configured for the stops it applies to and signed where it has to be.
 *
 * This replaces the single release-letter column. The reason it needed replacing
 * is the combination the column could not express: a BOL signed at the drop, a
 * release letter only shown at the collection, on the same order.
 *
 * Two rules carry the design:
 *   - **the original upload is never modified.** A signature produces a separate
 *     stamped copy, so the file the office sent and the file the customer agreed
 *     to are both recoverable, and neither can overwrite the other.
 *   - **signing blocks proof capture.** `findRequiredUnsigned` is the whole rule,
 *     and `pod.service` consults it before a driver may close a leg.
 */

export const KIND_LABELS: Record<OrderDocumentKind, string> = {
  [OrderDocumentKind.RELEASE_LETTER]: 'release letter',
  [OrderDocumentKind.BILL_OF_LADING]: 'bill of lading',
};

const SLUGS: Record<OrderDocumentKind, string> = {
  [OrderDocumentKind.RELEASE_LETTER]: 'release-letter',
  [OrderDocumentKind.BILL_OF_LADING]: 'bill-of-lading',
};

/**
 * `pdf-lib` embeds PNG and JPEG only, so a WebP signature could never be put on
 * the signed copy. Signatures are drawn on a canvas by the app, which produces a
 * PNG, so this costs nothing real — and rejecting it at the door beats storing a
 * signature that can never appear on the document it belongs to.
 */
const SIGNATURE_MIMES = new Set(['image/png', 'image/jpeg']);

async function docOr404(consignmentId: string, kind: OrderDocumentKind) {
  const order = await repo.consignmentExists(consignmentId);
  if (!order) throw AppError.notFound('Consignment not found');

  const doc = await repo.findByKind(consignmentId, kind);
  if (!doc) throw AppError.notFound(`No ${KIND_LABELS[kind]} has been attached to this order`);

  return { order, doc };
}

async function toDto(doc: repo.DocumentWithSignatures) {
  return {
    kind: doc.kind,
    label: KIND_LABELS[doc.kind],
    mime: doc.mime,
    bytes: doc.bytes,
    url: await storage.signedUrl(doc.path),
    showAtPickup: doc.showAtPickup,
    showAtDelivery: doc.showAtDelivery,
    signAtPickup: doc.signAtPickup,
    signAtDelivery: doc.signAtDelivery,
    createdAt: doc.createdAt,
    signatures: await Promise.all(
      doc.signatures.map(async (s) => ({
        leg: s.leg,
        capturedAt: s.capturedAt,
        signatureUrl: await storage.signedUrl(s.signaturePath),
        /** Null when the original could not be parsed — the signature still counts. */
        signedUrl: await storage.signedUrl(s.signedPath),
      })),
    ),
  };
}

/** Whether this document is shown at a leg. A sign flag always implies showing. */
function appliesTo(doc: repo.DocumentWithSignatures, leg: PodLeg): boolean {
  return leg === PodLeg.PICKUP
    ? doc.showAtPickup || doc.signAtPickup
    : doc.showAtDelivery || doc.signAtDelivery;
}

/**
 * Everything attached to an order, or just what applies to one stop.
 *
 * The driver app passes `leg` so it never shows paperwork for the other end of
 * the job; the console passes nothing and configures the lot.
 */
export async function list(consignmentId: string, leg?: PodLeg) {
  const order = await repo.consignmentExists(consignmentId);
  if (!order) throw AppError.notFound('Consignment not found');

  const all = await repo.listForConsignment(consignmentId);
  const visible = leg ? all.filter((d) => appliesTo(d, leg)) : all;

  return {
    consignmentId,
    leg: leg ?? null,
    documents: await Promise.all(visible.map(toDto)),
  };
}

/**
 * Store a document, replacing the file on whatever row is already there.
 *
 * Storage first, then the row: the reverse would leave a row pointing at a file
 * that was never written. The previous object is removed only once the new path
 * is committed, so a failed swap leaves the old document intact — the same order
 * as POD and driver documents, for the same reason.
 */
export async function put(
  consignmentId: string,
  kind: OrderDocumentKind,
  file: Express.Multer.File | undefined,
  actorUserId: string | null,
) {
  if (!file) throw AppError.badRequest('Attach the document as the "file" field');

  const order = await repo.consignmentExists(consignmentId);
  if (!order) throw AppError.notFound('Consignment not found');

  // The declared Content-Type was only an early reject; the bytes decide. PDFs
  // are accepted here and nowhere else, because POD must stay image-only.
  const sniffed = sniffImage(file.buffer) ?? sniffPdf(file.buffer);
  if (!sniffed) throw AppError.badRequest('That file is not a PDF, PNG, JPEG or WebP');

  const existing = await repo.findByKind(consignmentId, kind);
  const previous = existing?.path ?? null;

  const path = storage.objectPath(consignmentId, SLUGS[kind], sniffed.ext);
  await storage.uploadObject(path, file.buffer, sniffed.mime);

  await repo.upsertDoc(
    consignmentId,
    kind,
    { path, mime: sniffed.mime, bytes: file.size },
    actorUserId,
  );

  if (previous && previous !== path) await storage.removeObjects([previous]);

  return list(consignmentId);
}

/**
 * Change which stops a document applies to.
 *
 * A sign flag forces the matching show flag on. An operator who ticks "sign at
 * pickup" plainly means the driver should see it at pickup, and a document that
 * must be signed but is never displayed would block the leg with nothing on
 * screen to explain why — the single worst state this feature could reach.
 */
export async function setFlags(
  consignmentId: string,
  kind: OrderDocumentKind,
  flags: DocFlagsInput,
) {
  const { doc } = await docOr404(consignmentId, kind);

  const signAtPickup = flags.signAtPickup ?? doc.signAtPickup;
  const signAtDelivery = flags.signAtDelivery ?? doc.signAtDelivery;

  await repo.updateFlags(doc.id, {
    signAtPickup,
    signAtDelivery,
    showAtPickup: signAtPickup || (flags.showAtPickup ?? doc.showAtPickup),
    showAtDelivery: signAtDelivery || (flags.showAtDelivery ?? doc.showAtDelivery),
  });

  return list(consignmentId);
}

/**
 * Remove a document. Row first, then the objects: an orphaned file wastes a few
 * kilobytes, while a row pointing at a deleted object is a dead link on a phone.
 *
 * Its signatures go with it, by cascade. That is deliberate — a signature on a
 * document nobody can produce any more is not evidence of anything.
 */
export async function remove(consignmentId: string, kind: OrderDocumentKind) {
  const { doc } = await docOr404(consignmentId, kind);

  await repo.deleteDoc(doc.id);

  const paths = [doc.path];
  for (const s of doc.signatures) {
    paths.push(s.signaturePath);
    if (s.signedPath) paths.push(s.signedPath);
  }
  await storage.removeObjects(paths);

  return list(consignmentId);
}

/**
 * Capture a signature for one document at one stop, and build the signed copy.
 *
 * Ordering matters and is the same everywhere in this codebase: the signature
 * goes to storage, then the row, and only then do we try to stamp. If stamping
 * fails — an encrypted PDF, a WebP original, a file this library cannot parse —
 * the signature is already safe and `signedPath` simply stays null. Losing the
 * stamped copy is an inconvenience; losing the signature a customer stood there
 * and drew is not recoverable.
 */
export async function sign(
  consignmentId: string,
  kind: OrderDocumentKind,
  leg: PodLeg,
  file: Express.Multer.File | undefined,
  actor: { userId: string | null; driverId: string | null },
) {
  if (!file) throw AppError.badRequest('Attach the signature as the "signature" field');

  const { doc } = await docOr404(consignmentId, kind);

  const wanted = leg === PodLeg.PICKUP ? doc.signAtPickup : doc.signAtDelivery;
  if (!wanted) {
    throw AppError.conflict(
      `The ${KIND_LABELS[kind]} is not set to be signed at ${leg === PodLeg.PICKUP ? 'pickup' : 'delivery'}`,
    );
  }

  if (doc.signatures.some((s) => s.leg === leg)) {
    throw AppError.conflict(`The ${KIND_LABELS[kind]} has already been signed at this stop`);
  }

  const sniffed = sniffImage(file.buffer);
  if (!sniffed || !SIGNATURE_MIMES.has(sniffed.mime)) {
    throw AppError.badRequest(
      'The signature must be a PNG or JPEG image (its actual contents were checked, not its declared type)',
    );
  }

  const slug = `${SLUGS[kind]}-${leg.toLowerCase()}-signature`;
  const signaturePath = storage.objectPath(consignmentId, slug, sniffed.ext);
  await storage.uploadObject(signaturePath, file.buffer, sniffed.mime);

  const row = await repo.createSignature(
    doc.id,
    leg,
    { signaturePath, signatureMime: sniffed.mime, signatureBytes: file.size },
    actor.driverId,
    actor.userId,
  );

  const original = await storage.downloadObject(doc.path);
  if (original) {
    const stamped = await stampSigned({
      original,
      originalMime: doc.mime,
      signature: file.buffer,
      signatureMime: sniffed.mime,
      heading: `${KIND_LABELS[kind].replace(/^./, (c) => c.toUpperCase())} — signed at ${
        leg === PodLeg.PICKUP ? 'collection' : 'delivery'
      }`,
      rows: [
        ['Signed at', row.capturedAt.toISOString().replace('T', ' ').slice(0, 19)],
        ['Stop', leg === PodLeg.PICKUP ? 'Collection' : 'Delivery'],
        ['Document', KIND_LABELS[kind]],
      ],
    });

    if (stamped) {
      const signedPath = storage.objectPath(
        consignmentId,
        `${SLUGS[kind]}-${leg.toLowerCase()}-signed`,
        'pdf',
      );
      await storage.uploadObject(signedPath, stamped, 'application/pdf');
      await repo.setSignedCopy(row.id, {
        signedPath,
        signedMime: 'application/pdf',
        signedBytes: stamped.length,
      });
    }
  }

  return list(consignmentId);
}

/**
 * The documents this leg requires a signature on and does not have one for.
 *
 * Read by `pod.service` before a proof may be captured. Returning the labels
 * rather than a boolean is what lets the refusal name the paperwork, which is
 * the difference between a driver fixing it and a driver ringing the office.
 */
export async function blockingDocuments(consignmentId: string, leg: PodLeg): Promise<string[]> {
  const rows = await repo.findRequiredUnsigned(consignmentId, leg);
  return rows.map((r) => KIND_LABELS[r.kind]);
}

/* ------------------------------------------------ release letter (deprecated) */

/**
 * The shape the old `/release-letter` endpoints returned, served from the new
 * table so the deployed driver app and console keep working unchanged.
 *
 * Kept deliberately: breaking a phone build that is already in drivers' hands is
 * not a refactor, it is an outage. Remove once both clients use `/documents`.
 */
export async function releaseLetterCompat(consignmentId: string) {
  const order = await repo.consignmentExists(consignmentId);
  if (!order) throw AppError.notFound('Consignment not found');

  const doc = await repo.findByKind(consignmentId, OrderDocumentKind.RELEASE_LETTER);

  return {
    consignmentId,
    hasReleaseLetter: doc !== null,
    releaseLetterUrl: doc ? await storage.signedUrl(doc.path) : null,
  };
}

export async function putReleaseLetterCompat(
  consignmentId: string,
  file: Express.Multer.File | undefined,
  actorUserId: string | null,
) {
  await put(consignmentId, OrderDocumentKind.RELEASE_LETTER, file, actorUserId);
  return releaseLetterCompat(consignmentId);
}

export async function removeReleaseLetterCompat(consignmentId: string) {
  const doc = await repo.findByKind(consignmentId, OrderDocumentKind.RELEASE_LETTER);
  // The old endpoint was idempotent — removing nothing was a 200, not a 404.
  if (doc) await remove(consignmentId, OrderDocumentKind.RELEASE_LETTER);

  return { consignmentId, hasReleaseLetter: false, releaseLetterUrl: null };
}
