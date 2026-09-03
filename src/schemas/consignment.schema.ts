import { z } from 'zod';
import { PackageType, Priority, TaskType } from '@prisma/client';

/**
 * Every object here is `.strict()`: unknown keys are a 400, not a silent drop.
 * That is deliberate — `orderNo` and `status` are server-owned, and the previous
 * implementation accepted both and then ignored them, so a client could PUT a
 * status change, receive 200, and have nothing happen.
 */

const trimmed = (max: number) => z.string().trim().max(max);

/**
 * Address text is deliberately unvalidated beyond a length bound.
 *
 * City, province and postal code are filled by the console's address picker from
 * the geocoder, and an operator who edits them afterwards is taken at their word
 * — they are standing in front of the customer and the geocoder is not. There is
 * no province enum and no Canada Post pattern here, and no CHECK behind it
 * either; the coordinate is the field the system actually routes on.
 */

/**
 * Coordinates captured when the operator picks an address suggestion or drags
 * the map pin. Optional here even though the console insists on them, because
 * Postman and the seed also write through this schema.
 */
const lat = z.coerce.number().min(-90).max(90).optional();
const lng = z.coerce.number().min(-180).max(180).optional();

const senderSchema = z
  .object({
    name: trimmed(120).min(1, 'Sender name is required'),
    phone: trimmed(40).optional(),
    email: z.email().max(160).optional(),
    line1: trimmed(200).min(1, 'Sender address is required'),
    city: trimmed(80).min(1, 'Sender city is required'),
    province: trimmed(80).optional(),
    postcode: trimmed(20).optional(),
    instructions: trimmed(500).optional(),
    lat,
    lng,
  })
  .strict();

const receiverSchema = z
  .object({
    name: trimmed(120).min(1, 'Receiver name is required'),
    phone: trimmed(40).optional(),
    email: z.email().max(160).optional(),
    line1: trimmed(200).min(1, 'Receiver address is required'),
    city: trimmed(80).min(1, 'Receiver city is required'),
    province: trimmed(80).optional(),
    postcode: trimmed(20).optional(),
    notes: trimmed(500).optional(),
    lat,
    lng,
  })
  .strict();

export const itemSchema = z
  .object({
    /** Present = update this existing row; absent = create a new one. */
    id: z.string().min(1).optional(),
    description: trimmed(300).min(1, 'Item description is required'),
    qty: z.coerce.number().int().min(1, 'Quantity must be at least 1').default(1),
    weightKg: z.coerce.number().min(0).max(100_000).optional(),
    packageType: z.enum(PackageType).optional(),
    barcode: trimmed(80).optional(),
  })
  .strict();

export const createConsignmentSchema = z
  .object({
    clientId: z.string().min(1, 'Client is required'),
    clientReference: trimmed(64).optional(),

    taskType: z.enum(TaskType).default(TaskType.DELIVERY),
    priority: z.enum(Priority).default(Priority.NORMAL),

    sender: senderSchema,
    receiver: receiverSchema,

    /*
     * All four are REQUIRED. The columns are NOT NULL and the console's pickers
     * cannot be cleared, so a request arriving without them is a client that is
     * out of date — better a 400 naming the field than a Postgres 500.
     */
    pickupAfter: z.coerce.date(),
    pickupBefore: z.coerce.date(),
    deliverAfter: z.coerce.date(),
    deliverBefore: z.coerce.date(),

    generalNote: trimmed(2000).optional(),

    items: z.array(itemSchema).min(1, 'At least one item is required'),
  })
  .strict()
  /*
   * The same three rules the database enforces, checked here first so the caller
   * gets a 400 pointing at a field instead of a constraint-violation 500.
   */
  .refine((v) => v.pickupBefore >= v.pickupAfter, {
    message: 'Pickup window cannot close before it opens',
    path: ['pickupBefore'],
  })
  .refine((v) => v.deliverBefore >= v.deliverAfter, {
    message: 'Delivery window cannot close before it opens',
    path: ['deliverBefore'],
  })
  .refine((v) => v.deliverBefore >= v.pickupAfter, {
    message: 'Delivery deadline cannot fall before collection may start',
    path: ['deliverBefore'],
  });

export const updateConsignmentSchema = z
  .object({
    clientReference: trimmed(64).nullable().optional(),
    taskType: z.enum(TaskType).optional(),
    priority: z.enum(Priority).optional(),
    sender: senderSchema.optional(),
    receiver: receiverSchema.optional(),
    /*
     * Optional but NOT nullable: a partial edit may leave a window alone, but it
     * can never blank one — the columns are NOT NULL.
     */
    pickupAfter: z.coerce.date().optional(),
    pickupBefore: z.coerce.date().optional(),
    deliverAfter: z.coerce.date().optional(),
    deliverBefore: z.coerce.date().optional(),
    generalNote: trimmed(2000).nullable().optional(),
    /** Omit to leave items untouched; supply to replace the set by id. */
    items: z.array(itemSchema).min(1).optional(),
  })
  .strict();

export const consignmentIdParamSchema = z
  .object({ id: z.string().min(1) })
  .strict();

/**
 * The only statuses a plain status change may target.
 *
 * PICKED_UP and DELIVERED are absent on purpose — they are reachable only by
 * uploading proof of delivery. ASSIGNED and UNASSIGNED are absent too, since
 * those belong to the assignment endpoints. Enforcing it here means a request
 * for DELIVERED is rejected by the validator and never reaches a service, so
 * the rule cannot be lost in a later refactor of the service layer.
 */
export const changeStatusSchema = z
  .object({
    status: z.enum([
      'EN_ROUTE_TO_PICKUP',
      'AT_PICKUP',
      'EN_ROUTE_TO_DELIVERY',
      'AT_DELIVERY',
    ]),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

export type ChangeStatusInput = z.infer<typeof changeStatusSchema>;

export type CreateConsignmentInput = z.infer<typeof createConsignmentSchema>;
export type UpdateConsignmentInput = z.infer<typeof updateConsignmentSchema>;
export type ItemInput = z.infer<typeof itemSchema>;
