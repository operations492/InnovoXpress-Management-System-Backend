import type { UserRole } from '@prisma/client';
import { supabase } from '../../config/supabase.js';
import { AppError } from '../../utils/httpError.js';
import { forgetProfile } from '../../middleware/auth.js';
import * as repo from './users.repository.js';
import { nextColorIndex } from '../map/map.service.js';
import type { CreateUserInput, UpdateUserInput, UsersQuery } from '../../schemas/user.schema.js';

/**
 * User administration.
 *
 * Credentials live in Supabase Auth (`auth.users`, owned by GoTrue); role,
 * active flag and the driver link live in our `users` profile. Every write here
 * touches both, in that order, because the profile's primary key IS the auth
 * user's id.
 *
 * The role is also mirrored into the auth user's `app_metadata` — that is what
 * travels inside the JWT, and what RLS policies will read once Realtime is
 * enabled. `public.users.role` stays the source of truth; this function is the
 * only place that writes both, so they cannot drift.
 */

function toDto(u: Awaited<ReturnType<typeof repo.findById>>) {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    active: u.active,
    createdAt: u.createdAt,
    driver: u.driver
      ? {
          id: u.driver.id,
          name: u.driver.name,
          code: u.driver.code,
          active: u.driver.active,
          onShift: u.driver.onShift,
        }
      : null,
  };
}

async function syncClaims(userId: string, role: UserRole, driverId: string | null) {
  const { error } = await supabase.auth.admin.updateUserById(userId, {
    app_metadata: { role, driver_id: driverId },
  });
  if (error) throw AppError.badRequest(`Could not update the login: ${error.message}`);
}

/* ------------------------------------------------------------------ */
/* read                                                                */
/* ------------------------------------------------------------------ */

export async function list(query: UsersQuery) {
  const rows = await repo.listUsers({
    role: query.role,
    q: query.q,
    includeInactive: query.includeInactive === 'true',
  });
  return { data: rows.map(toDto) };
}

export async function get(id: string) {
  const user = toDto(await repo.findById(id));
  if (!user) throw AppError.notFound('User not found');
  return user;
}

export async function unlinkedDrivers() {
  return { data: await repo.findUnlinkedDrivers() };
}

/* ------------------------------------------------------------------ */
/* create                                                              */
/* ------------------------------------------------------------------ */

export async function create(input: CreateUserInput) {
  if (await repo.findByEmail(input.email)) {
    throw AppError.conflict('That email already has an account');
  }

  // Resolve the driver first: cheaper to fail here than after creating a login.
  let driverId: string | null = null;
  let createdDriverId: string | null = null;

  if (input.role === 'driver') {
    if (input.driverId) {
      const driver = await repo.findDriverById(input.driverId);
      if (!driver) throw AppError.badRequest('Unknown driver');
      if (driver.user) throw AppError.conflict(`${driver.name} already has a login`);
      if (!driver.active) throw AppError.badRequest(`${driver.name} is not an active driver`);
      driverId = driver.id;
    } else if (input.newDriver) {
      // Claim a map colour up front so the read path never has to fall back to
      // hashing the id. The palette is deliberately NOT unique: once all eight
      // slots are taken the least-used one is reused, so a ninth driver still
      // gets created rather than the create failing.
      const mapColorIndex = await nextColorIndex();
      const created = await repo.createDriver({ ...input.newDriver, mapColorIndex });
      driverId = created.id;
      createdDriverId = created.id;
    }
  }

  const { data, error } = await supabase.auth.admin.createUser({
    email: input.email,
    password: input.password,
    // Nobody ever receives a confirmation mail: these addresses are handed out
    // by an admin, and a courier should not need an inbox to start work.
    email_confirm: true,
    app_metadata: { role: input.role, driver_id: driverId },
    user_metadata: { name: input.name },
  });

  if (error || !data.user) {
    if (createdDriverId) await repo.deleteDriver(createdDriverId).catch(() => {});
    throw AppError.badRequest(`Could not create the login: ${error?.message ?? 'unknown error'}`);
  }

  try {
    const profile = await repo.createProfile({
      id: data.user.id,
      email: input.email,
      name: input.name,
      role: input.role,
      driverId,
    });
    return toDto(profile);
  } catch (e) {
    // Without this the account exists in Supabase, can sign in, and resolves to
    // no profile — a ghost that fails every request with a confusing 403.
    await supabase.auth.admin.deleteUser(data.user.id).catch(() => {});
    if (createdDriverId) await repo.deleteDriver(createdDriverId).catch(() => {});
    throw e;
  }
}

/* ------------------------------------------------------------------ */
/* update                                                              */
/* ------------------------------------------------------------------ */

export async function update(id: string, input: UpdateUserInput, actorId: string) {
  const existing = await repo.findById(id);
  if (!existing) throw AppError.notFound('User not found');

  const demoting = input.role !== undefined && input.role !== existing.role;
  const deactivating = input.active === false && existing.active;

  // Guard 1 — you cannot strip your own powers. An admin who demotes themselves
  // by accident cannot undo it, because undoing it needs admin.
  if (id === actorId && (demoting || deactivating)) {
    throw AppError.badRequest('You cannot change your own role or deactivate yourself');
  }

  // Guard 2 — never leave the system with no way in.
  if (existing.role === 'admin' && (demoting || deactivating)) {
    if ((await repo.countActiveAdmins()) <= 1) {
      throw AppError.badRequest('This is the last active admin — promote someone else first');
    }
  }

  if (input.email && input.email !== existing.email) {
    if (await repo.findByEmail(input.email)) {
      throw AppError.conflict('That email already has an account');
    }
  }

  // Credentials first: if Supabase refuses, the profile is left untouched.
  if (input.email || input.password) {
    const { error } = await supabase.auth.admin.updateUserById(id, {
      ...(input.email ? { email: input.email, email_confirm: true } : {}),
      ...(input.password ? { password: input.password } : {}),
    });
    if (error) throw AppError.badRequest(`Could not update the login: ${error.message}`);
  }

  const profile = await repo.updateProfile(id, {
    ...(input.email ? { email: input.email } : {}),
    ...(input.name ? { name: input.name } : {}),
    ...(input.role ? { role: input.role } : {}),
    ...(input.active !== undefined ? { active: input.active } : {}),
  });

  if (input.role) await syncClaims(id, input.role, profile.driverId);

  // A deactivated driver is also off the roster and off shift.
  if (input.active !== undefined && existing.driverId) {
    await repo.setDriverActive(existing.driverId, input.active);
  }

  // Make the change bite now rather than when the cached profile expires.
  forgetProfile(id);
  return toDto(profile);
}

/* ------------------------------------------------------------------ */
/* delete                                                              */
/* ------------------------------------------------------------------ */

export async function remove(id: string, actorId: string) {
  const existing = await repo.findById(id);
  if (!existing) throw AppError.notFound('User not found');

  if (id === actorId) throw AppError.badRequest('You cannot delete your own account');

  if (existing.role === 'admin' && (await repo.countActiveAdmins()) <= 1) {
    throw AppError.badRequest('This is the last active admin — promote someone else first');
  }

  // Deleting the LOGIN is always allowed; deleting the DRIVER is not, if they
  // have worked. The two are separate on purpose.
  await supabase.auth.admin.deleteUser(id).catch((e: unknown) => {
    console.error('Could not delete the Supabase user', e);
  });
  await repo.deleteProfile(id);
  forgetProfile(id);

  return { deleted: true, driverKept: existing.driverId !== null };
}

/**
 * Remove a driver from the roster entirely.
 *
 * Only possible while they have no history. `consignments.driverId` is
 * `onDelete: Restrict`, so Postgres would refuse anyway — this turns a raw
 * foreign-key error into an answer the operator can act on.
 */
export async function removeDriver(driverId: string) {
  const driver = await repo.findDriverById(driverId);
  if (!driver) throw AppError.notFound('Driver not found');

  const { consignments, proofs } = await repo.driverFootprint(driverId);
  if (consignments > 0 || proofs > 0) {
    throw AppError.conflict(
      `${driver.name} has ${consignments} consignment(s) and ${proofs} proof(s) on record. ` +
        'Deactivate them instead — deleting would erase who delivered what.',
    );
  }

  if (driver.user) {
    await supabase.auth.admin.deleteUser(driver.user.id).catch(() => {});
    await repo.deleteProfile(driver.user.id);
    forgetProfile(driver.user.id);
  }
  await repo.deleteDriver(driverId);
  return { deleted: true };
}

/* ------------------------------------------------------------------ */
/* the driver's own shift switch                                       */
/* ------------------------------------------------------------------ */

export async function setShift(driverId: string, onShift: boolean) {
  const row = await repo.setShift(driverId, onShift);
  // The id comes from the caller's own token, so this only fires if the driver
  // record was deleted while they held a session.
  if (!row) throw AppError.notFound('Driver not found');
  return row;
}
