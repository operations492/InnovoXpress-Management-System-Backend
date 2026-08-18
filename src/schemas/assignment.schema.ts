import { z } from 'zod';

export const assignDriverSchema = z
  .object({
    driverId: z.string().min(1, 'Driver is required'),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

export const driversQuerySchema = z
  .object({
    /** Search by driver name or code. */
    q: z.string().trim().min(1).max(80).optional(),
    includeInactive: z.enum(['true', 'false']).default('false'),
    /**
     * Only drivers who have clocked in. This is what the assignment popover
     * sends — an operator should be offered people who are actually working.
     *
     * Absent (the default) still returns every active driver, so dispatch is
     * not blocked at 6am before anyone has tapped the button.
     */
    onShift: z.enum(['true', 'false']).optional(),
  })
  .strict();

export type AssignDriverInput = z.infer<typeof assignDriverSchema>;
export type DriversQuery = z.infer<typeof driversQuerySchema>;
