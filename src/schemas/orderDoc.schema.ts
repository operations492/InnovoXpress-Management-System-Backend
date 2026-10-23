import { OrderDocumentKind, PodLeg } from '@prisma/client';
import { z } from 'zod';

/**
 * Requests for an order's documents.
 *
 * As everywhere in this API the objects are `.strict()`, so an unknown key is a
 * 400 rather than a silently ignored flag — which matters more here than usual:
 * a misspelled `signAtDropoff` that was quietly dropped would read on screen as
 * "signing is off" while the operator believed they had switched it on.
 */

/** `release-letter` / `bill-of-lading` in the URL, the enum everywhere else. */
export const KIND_SLUGS: Record<string, OrderDocumentKind> = {
  'release-letter': OrderDocumentKind.RELEASE_LETTER,
  'bill-of-lading': OrderDocumentKind.BILL_OF_LADING,
};

export const docKindParamSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(Object.keys(KIND_SLUGS) as [string, ...string[]]),
  })
  .strict();

export const docSignParamSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(Object.keys(KIND_SLUGS) as [string, ...string[]]),
    leg: z.enum(['pickup', 'delivery']),
  })
  .strict();

/**
 * Which stops a document applies to.
 *
 * Every flag is optional so the console can send one checkbox at a time, and the
 * service fills the gaps from what is already stored. A body with no flags at
 * all is a no-op rather than a reset — a PATCH that silently cleared three
 * settings because it only mentioned the fourth would be a trap.
 */
export const docFlagsSchema = z
  .object({
    showAtPickup: z.boolean().optional(),
    showAtDelivery: z.boolean().optional(),
    signAtPickup: z.boolean().optional(),
    signAtDelivery: z.boolean().optional(),
  })
  .strict();

/** A driver asks only about the stop they are standing at. */
export const docListQuerySchema = z
  .object({ leg: z.enum(PodLeg).optional() })
  .strict();

export type DocFlagsInput = z.infer<typeof docFlagsSchema>;
export type DocListQuery = z.infer<typeof docListQuerySchema>;
