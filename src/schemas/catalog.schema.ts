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

/*
 * Additional services carry a standard price as well as a name, so they get
 * their own pair of schemas rather than widening the shared ones — a freight
 * item has no price of its own and must not start accepting one.
 *
 * It is nullable: clearing the default is a real edit, distinct from leaving it
 * alone, and means "this charge has to be priced on each rate card".
 */
const defaultRate = z.coerce.number().min(0).max(9_999_999.99);

/** "HH:MM", 24-hour. The same shape a CHECK enforces in the database. */
const clock = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM on a 24-hour clock');

/*
 * Business hours travel as one value object and are replaced wholesale, the way
 * a client's address does — null clears both windows. Each window is set as a
 * pair or not at all: half a window cannot say when the working day ends.
 */
const hours = z
  .object({
    weekdayFrom: clock.nullable().default(null),
    weekdayTo: clock.nullable().default(null),
    weekendFrom: clock.nullable().default(null),
    weekendTo: clock.nullable().default(null),
  })
  .strict()
  .refine((v) => (v.weekdayFrom === null) === (v.weekdayTo === null), {
    message: 'Give both ends of the weekday window, or neither',
    path: ['weekdayTo'],
  })
  .refine((v) => (v.weekendFrom === null) === (v.weekendTo === null), {
    message: 'Give both ends of the weekend window, or neither',
    path: ['weekendTo'],
  });

export const createAdditionalServiceSchema = z
  .object({
    name,
    sortOrder: sortOrder.optional(),
    defaultRate: defaultRate.nullable().optional(),
  })
  .strict();

export const updateAdditionalServiceSchema = z
  .object({
    name: name.optional(),
    sortOrder: sortOrder.optional(),
    active: z.boolean().optional(),
    defaultRate: defaultRate.nullable().optional(),
    /** Only a system-added charge keeps these; the service refuses them otherwise. */
    hours: hours.nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export type CreateAdditionalServiceInput = z.infer<typeof createAdditionalServiceSchema>;
export type UpdateAdditionalServiceInput = z.infer<typeof updateAdditionalServiceSchema>;

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
