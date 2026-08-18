import type { UserRole } from '@prisma/client';

/**
 * Who is making this request.
 *
 * Assembled by `middleware/auth.ts` from a Supabase-signed token plus our own
 * profile row. Note there is no longer a `TokenRole` union: `driver` is a real
 * `UserRole` now that drivers hold real accounts, so the token role and the
 * database role are the same thing.
 */
export interface AuthUser {
  /** The Supabase `auth.users.id`, which is also our `users.id`. */
  id: string;
  email: string;
  role: UserRole;
  active: boolean;
  /** Set only on driver accounts — the roster row this login speaks for. */
  driverId: string | null;
}

/** The claims we care about out of a Supabase access token. */
export interface SupabaseClaims {
  sub: string;
  email?: string;
  /**
   * Supabase's own claim. It is the POSTGRES role used for RLS and is always
   * one of `anon` / `authenticated` / `service_role` — never our application
   * role. Ours lives in `app_metadata.role`.
   */
  role?: string;
  app_metadata?: { role?: string; driver_id?: string | null };
}
