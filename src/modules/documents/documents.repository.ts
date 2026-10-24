import type { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma.js';

/** Everything either document prints, in one round trip. */
export const printInclude = {
  client: { select: { name: true, code: true } },
  driver: { select: { name: true } },
  serviceLevel: { select: { name: true } },
  items: { orderBy: { createdAt: 'asc' } },
  /*
   * The POD report needs both: the proof carries the signature, the signatory and
   * the coordinate, while `Arrival Time` and the wait at each stop exist only as
   * the audit trail of when the driver reported arriving.
   *
   * Ordered oldest-first so the report's stop blocks read pickup then delivery
   * without the renderer having to know the lifecycle.
   */
  proofs: {
    orderBy: { capturedAt: 'asc' },
    include: { capturedByDriver: { select: { name: true } } },
  },
  trackingEvents: { orderBy: { recordedAt: 'asc' } },
} satisfies Prisma.ConsignmentInclude;

export type PrintableConsignment = Prisma.ConsignmentGetPayload<{
  include: typeof printInclude;
}>;

export function findForPrint(id: string) {
  return prisma.consignment.findUnique({ where: { id }, include: printInclude });
}
