import * as repo from './auth.repository.js';
import { AppError } from '../../utils/httpError.js';

/**
 * What is left of authentication on this side.
 *
 * Logging in happens against Supabase Auth directly from the client, which is
 * why there is no `login` here any more — and no bcrypt, no token signing, no
 * refresh handling. This backend only ever VERIFIES a token (see
 * middleware/auth.ts) and answers "who am I".
 */
export async function me(userId: string) {
  const user = await repo.findProfileWithDriver(userId);
  if (!user) throw AppError.unauthorized();

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    active: user.active,
    /** Present only for drivers — what the phone needs to show its own state. */
    driver: user.driver
      ? {
          id: user.driver.id,
          name: user.driver.name,
          code: user.driver.code,
          active: user.driver.active,
          onShift: user.driver.onShift,
        }
      : null,
  };
}

/**
 * Register (or clear) this session's push token.
 *
 * Clearing is a real operation, not an oversight: the app posts `null` on sign
 * out, so a shared or handed-over phone stops receiving the previous driver's
 * jobs the moment they leave.
 */
export async function setPushToken(userId: string, pushToken: string | null) {
  await repo.setPushToken(userId, pushToken);
}
