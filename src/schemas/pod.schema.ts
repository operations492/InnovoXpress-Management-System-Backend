import { z } from 'zod';
import { PodLeg } from '@prisma/client';

/** `pickup` / `delivery` in the URL, uppercased to the enum. */
export const podLegParamSchema = z
  .object({
    id: z.string().min(1),
    leg: z
      .enum(['pickup', 'delivery'])
      .transform((v) => (v === 'pickup' ? PodLeg.PICKUP : PodLeg.DELIVERY)),
  })
  .strict();

/**
 * Everything in a multipart request arrives as a string, so any non-string field
 * has to be coerced rather than declared.
 */
export const podBodySchema = z
  .object({
    capturedByDriverId: z.string().min(1).optional(),
    /// The person who signed. Trimmed and bounded like every other free text
    /// here; optional on the wire so an older client keeps working, and so a
    /// handover genuinely nobody named is still recordable.
    signedByName: z.string().trim().min(1).max(120).optional(),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

export type PodLegParams = z.infer<typeof podLegParamSchema>;
export type PodBody = z.infer<typeof podBodySchema>;
