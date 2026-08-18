import { z } from 'zod';
import { UserRole } from '@prisma/client';

/**
 * Every object is `.strict()`, matching the rest of the API: an unknown key is
 * a 400 rather than a silent drop.
 */

const trimmed = (max: number) => z.string().trim().max(max);

/**
 * Supabase enforces a minimum of 6, but these accounts are handed out by an
 * admin and typed once into a phone, so 8 is a cheap improvement.
 */
const password = z.string().min(8, 'Password must be at least 8 characters').max(72);

/** Details for a courier who is not yet on the roster. */
const newDriverSchema = z
  .object({
    name: trimmed(120).min(1, 'Driver name is required'),
    code: trimmed(20).optional(),
    mobile: trimmed(40).optional(),
  })
  .strict();

export const createUserSchema = z
  .object({
    email: z.email().max(160),
    password,
    name: trimmed(120).min(1, 'Name is required'),
    role: z.enum(UserRole),

    /** Give an existing roster driver a login. */
    driverId: z.string().min(1).optional(),
    /** …or create the roster row at the same time. */
    newDriver: newDriverSchema.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.role === 'driver') {
      // Exactly one of the two, or the account resolves to no driver — and a
      // driver token with no driverId fails every driver route.
      if (!v.driverId && !v.newDriver) {
        ctx.addIssue({
          code: 'custom',
          path: ['driverId'],
          message: 'A driver account must link an existing driver or create a new one',
        });
      }
      if (v.driverId && v.newDriver) {
        ctx.addIssue({
          code: 'custom',
          path: ['driverId'],
          message: 'Link an existing driver or create a new one, not both',
        });
      }
    } else if (v.driverId || v.newDriver) {
      ctx.addIssue({
        code: 'custom',
        path: ['role'],
        message: 'Only a driver account can be linked to a driver record',
      });
    }
  });

export const updateUserSchema = z
  .object({
    email: z.email().max(160).optional(),
    password: password.optional(),
    name: trimmed(120).min(1).optional(),
    role: z.enum(UserRole).optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export const usersQuerySchema = z
  .object({
    role: z.enum(UserRole).optional(),
    q: trimmed(120).optional(),
    includeInactive: z.enum(['true', 'false']).default('false'),
  })
  .strict();

export const userIdParamSchema = z.object({ id: z.string().min(1) }).strict();

/** The driver's own clock-in switch. */
export const shiftSchema = z.object({ onShift: z.boolean() }).strict();

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type UsersQuery = z.infer<typeof usersQuerySchema>;
