import { z } from 'zod';

const name = z.string().trim().min(1, 'Name is required').max(80);

export const createServiceLevelSchema = z
  .object({
    name,
    /** Position in the dropdown; omitted means "after everything else". */
    sortOrder: z.coerce.number().int().min(0).max(10_000).optional(),
  })
  .strict();

/** Every field optional: rename, reorder, or retire/restore in one call. */
export const updateServiceLevelSchema = z
  .object({
    name: name.optional(),
    sortOrder: z.coerce.number().int().min(0).max(10_000).optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export const serviceLevelIdParamSchema = z.object({ id: z.string().min(1) }).strict();

export const listServiceLevelsQuerySchema = z
  .object({
    /** 'true' includes retired levels — the admin screen wants them, the dropdown does not. */
    includeInactive: z.enum(['true', 'false']).default('false'),
  })
  .strict();

export type CreateServiceLevelInput = z.infer<typeof createServiceLevelSchema>;
export type UpdateServiceLevelInput = z.infer<typeof updateServiceLevelSchema>;
export type ListServiceLevelsQuery = z.infer<typeof listServiceLevelsQuerySchema>;
