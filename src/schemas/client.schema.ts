import { z } from 'zod';

/** The thirteen provinces and territories. Same closed set the consignment form offers. */
export const PROVINCES = [
  'AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT',
] as const;

const name = z.string().trim().min(1, 'Name is required').max(120);

/**
 * The code prefixes every order number this client is ever given, so it is
 * stored upper-case and kept short. The service refuses to change it once the
 * client has orders.
 */
const code = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9]{2,6}$/, 'Code must be 2-6 letters or digits')
  .transform((v) => v.toUpperCase());

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

/**
 * Canada Post format. Stored canonically as "A1A 1A1" so LEFT(postcode, 3) is
 * always a clean FSA, matching how the consignment snapshot stores it.
 */
const postcode = z
  .string()
  .trim()
  .regex(/^[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d$/, 'Postcode must look like A1A 1A1')
  .transform((v) => {
    const bare = v.toUpperCase().replace(/[\s-]/g, '');
    return `${bare.slice(0, 3)} ${bare.slice(3)}`;
  })
  .nullable()
  .optional();

/**
 * The address is replaced wholesale, never patched field by field. line1, city
 * and the coordinate pair are required *inside* the object, which makes a
 * half-filled address unrepresentable rather than merely discouraged — there is
 * no merge step where three valid PATCHes add up to an unroutable row.
 * Send `address: null` to clear it.
 */
export const clientAddressSchema = z
  .object({
    contactName: optionalText(120),
    phone: optionalText(40),
    email: z
      .string()
      .trim()
      .max(160)
      .regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, 'Invalid email')
      .nullable()
      .optional(),
    line1: z.string().trim().min(1, 'Street address is required').max(200),
    city: z.string().trim().min(1, 'City is required').max(80),
    province: z.enum(PROVINCES).nullable().optional(),
    postcode,
    /** Set by the console's TomTom picker; both or neither, enforced by being required here. */
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    instructions: optionalText(500),
  })
  .strict();

export const createClientSchema = z
  .object({
    name,
    code,
    address: clientAddressSchema.nullable().optional(),
  })
  .strict();

/** Every field optional: rename, recode, retire, or set the address in one call. */
export const updateClientSchema = z
  .object({
    name: name.optional(),
    code: code.optional(),
    active: z.boolean().optional(),
    address: clientAddressSchema.nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export const clientIdParamSchema = z.object({ id: z.string().min(1) }).strict();

export const listClientsQuerySchema = z
  .object({
    /** 'true' includes retired clients — the admin screen wants them, the dropdown does not. */
    includeInactive: z.enum(['true', 'false']).default('false'),
  })
  .strict();

export type ClientAddressInput = z.infer<typeof clientAddressSchema>;
export type CreateClientInput = z.infer<typeof createClientSchema>;
export type UpdateClientInput = z.infer<typeof updateClientSchema>;
export type ListClientsQuery = z.infer<typeof listClientsQuerySchema>;
