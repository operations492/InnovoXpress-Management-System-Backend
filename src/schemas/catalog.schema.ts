import { z } from 'zod';

/*
 * Shared request shapes for the flat catalogue lookups — additional services and
 * freight items. The two are identical in shape, so they share these schemas
 * rather than each getting a copy; the modules stay separate because they will
 * diverge (freight items will want weight/dimension defaults, additional
 * services a unit of charge) and unpicking a shared service then costs more
 * than the duplication saves.
 */

const name = z.string().trim().min(1, 'Name is required').max(80);
const sortOrder = z.coerce.number().int().min(0).max(10_000);

export const createCatalogEntrySchema = z
  .object({
    name,
    /** Position in the list; omitted means "after everything else". */
    sortOrder: sortOrder.optional(),
  })
  .strict();

/** Every field optional: rename, reorder, or retire/restore in one call. */
export const updateCatalogEntrySchema = z
  .object({
    name: name.optional(),
    sortOrder: sortOrder.optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export const catalogIdParamSchema = z.object({ id: z.string().min(1) }).strict();

export const listCatalogQuerySchema = z
  .object({
    /** 'true' includes retired entries — the admin screen wants them, a dropdown does not. */
    includeInactive: z.enum(['true', 'false']).default('false'),
  })
  .strict();

export type CreateCatalogEntryInput = z.infer<typeof createCatalogEntrySchema>;
export type UpdateCatalogEntryInput = z.infer<typeof updateCatalogEntrySchema>;
export type ListCatalogQuery = z.infer<typeof listCatalogQuerySchema>;
