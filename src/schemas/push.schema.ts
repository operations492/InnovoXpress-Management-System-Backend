import { z } from 'zod';

/**
 * Registering where to push notifications for the signed-in person.
 *
 * `null` is a meaningful value, not an omission — the app sends it on sign-out
 * so a handed-over phone stops receiving the previous driver's jobs. Hence
 * `.nullable()` rather than `.optional()`: leaving the field out is a mistake,
 * clearing it deliberately is not.
 *
 * The shape is checked here as well as in the sender. Rejecting rubbish at the
 * edge keeps a row from being written that could never deliver, and the caller
 * gets a 400 that names the field instead of silence.
 */
export const pushTokenSchema = z
  .object({
    pushToken: z
      .string()
      .trim()
      .regex(/^Expo(nent)?PushToken\[[^\]]+\]$/, 'Not an Expo push token')
      .nullable(),
  })
  .strict();

export type PushTokenBody = z.infer<typeof pushTokenSchema>;
