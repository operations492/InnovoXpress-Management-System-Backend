import supertest from 'supertest';
import { createClient } from '@supabase/supabase-js';
import app from '../../src/app.js';
import { prisma } from '../../src/config/prisma.js';
import { env } from '../../src/config/env.js';
import { supabase } from '../../src/config/supabase.js';
import { forgetAllProfiles } from '../../src/middleware/auth.js';

export const api = supertest(app);
export { prisma };

/**
 * ⚠️ These helpers create and delete REAL Supabase Auth accounts.
 *
 * The suite already truncates consignments before every test; it now also
 * writes to the project's auth store. Pointed at the shared team project this
 * removes colleagues' logins, not just their demo orders — so a scratch
 * Supabase project (`.env.test`) is no longer merely advisable.
 *
 * Every account created here uses the `@test.innovoxpress.local` domain so a
 * stray one is obvious and safe to purge.
 */
export const TEST_DOMAIN = 'test.innovoxpress.local';
const TEST_PASSWORD = 'TestPassword!123';

export const TEST_ADMIN_EMAIL = `admin@${TEST_DOMAIN}`;

/**
 * Sign-ins get their OWN client.
 *
 * supabase-js stores the session on the client instance, so calling
 * signInWithPassword on the shared service-role client silently swaps its
 * credentials for a user's — and every later Storage upload then runs as
 * `authenticated`, with no policy, and fails RLS. The API itself never signs
 * anyone in, so only tests can trip this.
 */
const authClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export interface Reference {
  clientId: string;
  clientCode: string;
  otherClientId: string;
  otherClientCode: string;
  driverId: string;
  /** A second driver, for ownership tests. */
  driverBId: string;
}

/**
 * Create (or reuse) a Supabase login plus its profile.
 *
 * Idempotent by email: a previous run may have left the account behind, and
 * `createUser` errors rather than no-ops on a duplicate.
 */
async function ensureLogin(opts: {
  email: string;
  name: string;
  role: 'admin' | 'operator' | 'driver';
  driverId?: string;
}): Promise<string> {
  const existing = await prisma.user.findUnique({ where: { email: opts.email } });
  if (existing) {
    // Keep the password and claims in sync with what the tests expect.
    await supabase.auth.admin.updateUserById(existing.id, {
      password: TEST_PASSWORD,
      app_metadata: { role: opts.role, driver_id: opts.driverId ?? null },
    });
    await prisma.user.update({
      where: { id: existing.id },
      data: { role: opts.role, active: true, driverId: opts.driverId ?? null },
    });
    return existing.id;
  }

  const { data, error } = await supabase.auth.admin.createUser({
    email: opts.email,
    password: TEST_PASSWORD,
    email_confirm: true,
    app_metadata: { role: opts.role, driver_id: opts.driverId ?? null },
  });
  if (error || !data.user) {
    throw new Error(`Could not create test login ${opts.email}: ${error?.message}`);
  }

  await prisma.user.create({
    data: {
      id: data.user.id,
      email: opts.email,
      name: opts.name,
      role: opts.role,
      driverId: opts.driverId ?? null,
    },
  });
  return data.user.id;
}

/** Idempotent lookups every suite relies on. */
export async function seedReference(): Promise<Reference> {
  const client = await prisma.client.upsert({
    where: { code: 'TCA' },
    update: { name: 'Test Client A', active: true },
    create: { name: 'Test Client A', code: 'TCA', active: true },
  });

  const other = await prisma.client.upsert({
    where: { code: 'TCB' },
    update: { name: 'Test Client B', active: true },
    create: { name: 'Test Client B', code: 'TCB', active: true },
  });

  /*
   * Both test drivers are clocked ON.
   *
   * Assignment refuses an off-shift driver, so most of the suite could not create
   * an assigned order otherwise. Set explicitly in `update` as well as `create`,
   * because the column defaults to false and a previous suite may have clocked
   * them off — a test's starting state must not depend on what ran before it.
   */
  const driver = await prisma.driver.upsert({
    where: { code: 'test-driver-1' },
    update: { name: 'Test Driver', active: true, onShift: true },
    create: { name: 'Test Driver', code: 'test-driver-1', active: true, onShift: true },
  });

  const driverB = await prisma.driver.upsert({
    where: { code: 'test-driver-b' },
    update: { name: 'Test Driver B', active: true, onShift: true },
    create: { name: 'Test Driver B', code: 'test-driver-b', active: true, onShift: true },
  });

  await ensureLogin({ email: TEST_ADMIN_EMAIL, name: 'Test Admin', role: 'admin' });
  await ensureLogin({
    email: `driver1@${TEST_DOMAIN}`,
    name: 'Test Driver',
    role: 'driver',
    driverId: driver.id,
  });
  await ensureLogin({
    email: `driverb@${TEST_DOMAIN}`,
    name: 'Test Driver B',
    role: 'driver',
    driverId: driverB.id,
  });

  // The middleware caches profiles for 30s; a suite that just rewrote them must
  // not read the previous run's.
  forgetAllProfiles();

  return {
    clientId: client.id,
    clientCode: client.code,
    otherClientId: other.id,
    otherClientCode: other.code,
    driverId: driver.id,
    driverBId: driverB.id,
  };
}

/**
 * Child-first. Must include orderCounter (or the order-number suite becomes
 * order-dependent) and driverLocation (or trails leak between tests).
 */
export async function cleanConsignments(): Promise<void> {
  await prisma.trackingEvent.deleteMany({});
  await prisma.proofOfDelivery.deleteMany({});
  await prisma.driverLocation.deleteMany({});
  // Positions survive a history wipe otherwise, and they are the yardstick the
  // service filters history against — a leftover row from the previous test would
  // make the next batch look stationary and silently write nothing.
  await prisma.driverPosition.deleteMany({});
  await prisma.item.deleteMany({});
  await prisma.consignment.deleteMany({});
  await prisma.orderCounter.deleteMany({});
}

/**
 * Sign in against Supabase Auth, exactly as a browser would.
 *
 * There is no `POST /api/auth/login` any more — this backend only verifies
 * tokens, so a test must obtain a real one the same way a client does.
 */
async function signIn(email: string): Promise<string> {
  const { data, error } = await authClient.auth.signInWithPassword({
    email,
    password: TEST_PASSWORD,
  });
  if (error || !data.session) {
    throw new Error(`Sign-in failed for ${email}: ${error?.message ?? 'no session'}`);
  }
  return data.session.access_token;
}

export function getToken(): Promise<string> {
  return signIn(TEST_ADMIN_EMAIL);
}

/** A driver-app token — a real Supabase session, not a self-issued claim. */
export function getDriverToken(driverId: string): Promise<string> {
  // Resolve which of the two seeded driver logins speaks for this roster row.
  return prisma.user
    .findFirst({ where: { driverId }, select: { email: true } })
    .then((u) => {
      if (!u) throw new Error(`No login is linked to driver ${driverId}`);
      return signIn(u.email);
    });
}

export function authHeader(token: string) {
  return { Authorization: `Bearer ${token}` };
}

/** Used by the users suite, which needs to know the project's own admin email. */
export const SEED_ADMIN_EMAIL = env.SEED_ADMIN_EMAIL;

/**
 * An extra console account. The seeded reference data has only one console
 * login, but chat needs at least two people who can talk to each other — and
 * a third who is in neither conversation, to prove the ownership guard.
 *
 * Reuses ensureLogin, so these are real Supabase accounts created
 * idempotently and kept in sync with TEST_PASSWORD.
 */
export async function ensureConsoleUser(opts: {
  email: string;
  name: string;
  role?: 'operator' | 'admin';
}): Promise<{ id: string; email: string; token: string }> {
  const id = await ensureLogin({
    email: opts.email,
    name: opts.name,
    role: opts.role ?? 'operator',
  });
  // The middleware caches profiles for 30s; a freshly changed role must not
  // be served from a stale entry mid-suite.
  forgetAllProfiles();
  const token = await signIn(opts.email);
  return { id, email: opts.email, token };
}

/**
 * Chat's equivalent of cleanConsignments(). Children first — the foreign keys
 * cascade, but being explicit keeps the intent obvious and the order stable.
 *
 * Also clears any broadcast rows our trigger wrote, so a realtime assertion
 * never sees a previous test's fan-out.
 */
export async function cleanChat(): Promise<void> {
  await prisma.chatMessage.deleteMany();
  await prisma.chatMember.deleteMany();
  await prisma.chatConversation.deleteMany();
  await prisma.$executeRawUnsafe(`delete from realtime.messages where topic like 'chat:%'`);
}
