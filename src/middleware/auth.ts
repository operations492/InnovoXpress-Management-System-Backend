import type { Request, Response, NextFunction } from 'express';
import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from 'jose';
import { env } from '../config/env.js';
import { AppError } from '../utils/httpError.js';
import * as authRepo from '../modules/auth/auth.repository.js';
import type { AuthUser, SupabaseClaims } from '../types/auth.js';

/**
 * Identity, proved by Supabase.
 *
 * Tokens are signed by Supabase Auth with an ES256 key and verified here
 * LOCALLY against the project's public JWKS — no network round trip per
 * request. (Supabase explicitly advises against verifying HS256 tokens with a
 * shared secret, and tells HS256 projects to call the Auth server on every
 * request instead; this project uses asymmetric keys precisely to avoid that.)
 *
 * `createRemoteJWKSet` fetches the key set once, caches it, and re-fetches when
 * it meets an unknown `kid` — which is what makes key rotation work without a
 * deploy.
 */
const JWKS = createRemoteJWKSet(new URL(`${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`));
const ISSUER = `${env.SUPABASE_URL}/auth/v1`;

/**
 * The role and driver link live in our own `users` row, not the token, so that
 * deactivating someone takes effect without waiting for their token to expire.
 *
 * A short cache keeps that from costing a database round trip on every request.
 * 30 seconds is the worst-case delay before a deactivation bites; an admin
 * action calls `forgetProfile` and makes it immediate.
 */
const PROFILE_TTL_MS = 30_000;
const profiles = new Map<string, { at: number; profile: AuthUser | null }>();

export function forgetProfile(userId: string): void {
  profiles.delete(userId);
}

export function forgetAllProfiles(): void {
  profiles.clear();
}

async function loadProfile(userId: string, email: string): Promise<AuthUser | null> {
  const hit = profiles.get(userId);
  if (hit && Date.now() - hit.at < PROFILE_TTL_MS) return hit.profile;

  const row = await authRepo.findUserById(userId);
  const profile: AuthUser | null = row
    ? {
        id: row.id,
        email: row.email || email,
        role: row.role,
        active: row.active,
        driverId: row.driverId ?? null,
      }
    : null;

  profiles.set(userId, { at: Date.now(), profile });
  return profile;
}

export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return next(AppError.unauthorized('Missing or malformed Authorization header'));
  }
  const token = header.slice('Bearer '.length).trim();

  let claims: SupabaseClaims;
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: ISSUER,
      audience: 'authenticated',
    });
    claims = payload as unknown as SupabaseClaims;
  } catch (err) {
    // A bad token and an unreachable Supabase are completely different
    // problems. The previous implementation reported both as "invalid or
    // expired token", which sends you debugging the wrong thing during an
    // outage.
    //
    // Classified by exclusion rather than by listing types: every JOSEError is
    // a problem with the TOKEN or the key it names — a bad signature, an
    // expired claim, an algorithm we do not publish, a `kid` that matches
    // nothing. Enumerating them missed cases and reported forged tokens as a
    // 503. Only a timeout, or a non-JOSE throw, means Supabase itself is
    // unreachable.
    if (err instanceof joseErrors.JOSEError && !(err instanceof joseErrors.JWKSTimeout)) {
      return next(AppError.unauthorized('Invalid or expired token'));
    }
    console.error('Could not reach the Supabase JWKS endpoint', err);
    return next(
      new AppError(503, 'AUTH_UNAVAILABLE', 'Could not reach the authentication service'),
    );
  }

  if (!claims.sub) return next(AppError.unauthorized('Token has no subject'));

  const profile = await loadProfile(claims.sub, claims.email ?? '');

  // Signed in with Supabase but no profile: either the account was created
  // outside this app, or a create half-failed. Either way they have no role, so
  // they can do nothing.
  if (!profile) {
    return next(AppError.forbidden('This account has no profile in the system'));
  }
  if (!profile.active) {
    return next(AppError.forbidden('This account has been deactivated'));
  }

  req.user = profile;
  next();
}
