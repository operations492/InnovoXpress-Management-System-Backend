import { z } from 'zod';

/*
 * Zone lists, zones, and the postal codes inside them.
 *
 * The codes arrive as one pasted box of text rather than as an array, because
 * that is what an operator actually has: a column copied out of a spreadsheet.
 * Splitting, normalizing, classifying and de-duplicating happen in the service
 * (see utils/postalCode.ts), so the shape of what was typed is never lost before
 * it can be shown back in a preview.
 *
 * There are deliberately no ranges. Canadian codes are not ordinal, so "M5V to
 * M5X" names no definite set of streets, and offering the field would invite an
 * operator to believe otherwise.
 */

const name = z.string().trim().min(1, 'Name is required').max(80);
const description = z.string().trim().max(500);
const shortName = z.string().trim().max(24);

export const createZoneListSchema = z
  .object({
    name,
    description: description.optional(),
  })
  .strict();

export const updateZoneListSchema = z
  .object({
    name: name.optional(),
    description: description.nullable().optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export const createZoneSchema = z
  .object({
    name,
    shortName: shortName.optional(),
  })
  .strict();

export const updateZoneSchema = z
  .object({
    name: name.optional(),
    shortName: shortName.nullable().optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

/**
 * The box exactly as typed. An empty string is legal and means "this zone has no
 * typed codes" — that is how the last one is removed.
 */
export const postalTextSchema = z
  .object({
    text: z.string().max(20_000),
  })
  .strict();

/**
 * A drawn shape, as GeoJSON geometry — what Leaflet's `toGeoJSON().geometry`
 * produces. A whole Feature is rejected on purpose: the properties on one are
 * drawing-tool state, and storing them would make the shape look like it meant
 * something to pricing. It does not.
 */
const geojsonPolygon = z
  .object({
    type: z.enum(['Polygon', 'MultiPolygon']),
    coordinates: z.array(z.any()).min(1),
  })
  .strict();

export const shapePreviewSchema = z.object({ geojson: geojsonPolygon }).strict();

/**
 * Saving takes the shape AND the codes to keep, rather than re-deriving them, so
 * that unticking one in the preview actually means something. The server still
 * checks every code for conflicts before writing.
 */
export const shapeSaveSchema = z
  .object({
    geojson: geojsonPolygon,
    codes: z.array(z.string().trim().min(3).max(7)).max(5_000),
  })
  .strict();

export const zoneListIdParamSchema = z.object({ id: z.string().min(1) }).strict();

export const zoneParamSchema = z
  .object({ id: z.string().min(1), zoneId: z.string().min(1) })
  .strict();

export const zoneCodeParamSchema = z
  .object({
    id: z.string().min(1),
    zoneId: z.string().min(1),
    /** Six characters plus a space is the longest anyone can type. */
    code: z.string().min(3).max(7),
  })
  .strict();

export const listZonesQuerySchema = z
  .object({
    includeInactive: z.enum(['true', 'false']).default('false'),
  })
  .strict();

export type CreateZoneListInput = z.infer<typeof createZoneListSchema>;
export type UpdateZoneListInput = z.infer<typeof updateZoneListSchema>;
export type CreateZoneInput = z.infer<typeof createZoneSchema>;
export type UpdateZoneInput = z.infer<typeof updateZoneSchema>;
export type PostalTextInput = z.infer<typeof postalTextSchema>;
export type ShapePreviewInput = z.infer<typeof shapePreviewSchema>;
export type ShapeSaveInput = z.infer<typeof shapeSaveSchema>;
export type ListZonesQuery = z.infer<typeof listZonesQuerySchema>;
