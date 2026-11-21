import { prisma } from '../src/config/prisma.js';
import { supabase } from '../src/config/supabase.js';
import { env } from '../src/config/env.js';

/**
 * Creates the ONE admin login, and nothing else.
 *
 *     npx tsx prisma/createAdmin.ts
 *
 * ADDITIVE. It deletes nothing — no storage object, no auth user, no row. That
 * is the whole reason it exists: `npm run seed` is the only other way to mint a
 * login, and it opens by wiping every consignment, every object in the `pod`
 * bucket and every Supabase Auth account, because it builds a demo world rather
 * than bootstrapping a real one.
 *
 * It also cannot be used through the API. `POST /api/users` sits behind
 * `authenticate` + `requireMinRole('admin')`, so the first admin is a
 * chicken-and-egg problem: there is nobody to authorise creating them. This
 * script is that one-time escape hatch, and it is deliberately the narrowest
 * possible one.
 *
 * Safe to re-run. Every branch below either reports and stops, or creates the
 * single thing that is missing.
 */

/**
 * A login is TWO records that must agree.
 *
 *   1. a Supabase Auth user — owns the password, and its UUID is the identity
 *   2. a `users` row whose `id` IS that UUID
 *
 * `User.id` has no default in the schema precisely because it is not ours to
 * generate. Create the auth user and forget the row and the person can sign in
 * but has no role, so the API rejects them on every request: middleware/auth.ts
 * resolves role from our own table, not from the token. That half-created state
 * is the one this script is most careful to repair rather than duplicate.
 */

/** The placeholder in src/config/env.ts. Refused outright — see below. */
const INSECURE_DEFAULT = 'ChangeMe!123';

/**
 * Find an auth user by email.
 *
 * The admin API has no "get by email", so this pages. `perPage: 1000` matches
 * what seed.ts uses; the loop stops on the first short page, so a fresh project
 * costs exactly one request.
 */
async function findAuthUser(email: string) {
  const perPage = 1000;

  for (let page = 1; ; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`Could not list auth users: ${error.message}`);

    const hit = data.users.find((u) => u.email?.toLowerCase() === email);
    if (hit) return hit;

    // A short page is the last page.
    if (data.users.length < perPage) return null;
  }
}

async function main() {
  // Supabase stores emails lowercased, so compare that way or a mixed-case
  // SEED_ADMIN_EMAIL would look absent and we would try to create a duplicate.
  const email = env.SEED_ADMIN_EMAIL.trim().toLowerCase();
  const password = env.SEED_ADMIN_PASSWORD;
  const name = env.SEED_ADMIN_NAME;

  /*
   * Refuse the placeholder password.
   *
   * `SEED_ADMIN_PASSWORD` defaults to a value that is published in this
   * repository. An admin account can create and delete every user, so shipping
   * one with a password from source control is not a risk worth taking for the
   * five seconds it costs to change it.
   */
  if (password === INSECURE_DEFAULT) {
    console.warn(
      `! SEED_ADMIN_PASSWORD is the placeholder "${INSECURE_DEFAULT}", which is the
` +
        `  default in src/config/env.ts and therefore readable by anyone with
` +
        `  access to this repository. Proceeding because it was asked for —
` +
        `  change it from the console once you are signed in.`,
    );
  }

  /*
   * One admin, enforced.
   *
   * Checked before anything is written, and by ROLE rather than by email, so a
   * second run with a different SEED_ADMIN_EMAIL cannot quietly add a second
   * administrator. Further admins are made from the console by the admin who
   * already exists, which is where that decision belongs and where it leaves a
   * trace.
   */
  const admin = await prisma.user.findFirst({
    where: { role: 'admin' },
    select: { email: true, active: true },
  });

  if (admin) {
    console.log(
      `· an admin already exists: ${admin.email}${admin.active ? '' : ' (INACTIVE)'}\n` +
        `  Nothing created. Add further users from the console.`,
    );
    return;
  }

  // A row on this email that is NOT an admin: changing its role here would be a
  // privilege escalation hidden inside a setup script. Report it instead.
  const taken = await prisma.user.findUnique({
    where: { email },
    select: { role: true },
  });

  if (taken) {
    console.error(
      `✗ ${email} already has a users row with role "${taken.role}".\n` +
        `  Refusing to promote it. Use a different SEED_ADMIN_EMAIL, or change\n` +
        `  that user's role deliberately once an admin exists.`,
    );
    process.exit(1);
  }

  // Reuse an existing auth user rather than failing on "already registered" —
  // this is the half-created case described at the top of the file.
  let authUser = await findAuthUser(email);

  if (authUser) {
    console.log(`· auth user already exists for ${email} — reusing it`);
    console.log(`  (password unchanged; reset it from Supabase if it is unknown)`);
  } else {
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      // No confirmation mail: there may be no SMTP configured, and an admin who
      // cannot sign in until they click a link nobody received is a dead end.
      email_confirm: true,
      // Mirrors seed.ts. Informational only — auth middleware reads the role
      // from our own table — but kept consistent so both paths look alike.
      app_metadata: { role: 'admin', driver_id: null },
      user_metadata: { name },
    });

    if (error || !data.user) {
      throw new Error(`Could not create auth user: ${error?.message ?? 'unknown error'}`);
    }

    authUser = data.user;
    console.log(`✓ auth user created`);
  }

  const row = await prisma.user.create({
    data: {
      // The auth UUID, never a generated one.
      id: authUser.id,
      // The address auth actually stored, so the two can never disagree.
      email: authUser.email ?? email,
      name,
      role: 'admin',
    },
  });

  console.log(`✓ admin ready: ${row.email}`);
  console.log(`  id   : ${row.id}`);
  console.log(`  name : ${row.name}`);
  console.log(`\nSign in to the console with this email and SEED_ADMIN_PASSWORD.`);
}

main()
  .catch((e) => {
    console.error('Failed to create admin:', e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
