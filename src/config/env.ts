import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  /** Runtime connection. On Supabase use the session-mode pooler host, port 5432. */
  DATABASE_URL: z.url(),
  /**
   * Connection used by the Prisma CLI (migrate/db push). Optional — falls back to
   * DATABASE_URL. Must NOT point at a transaction pooler: Prisma Migrate takes a
   * session-scoped advisory lock that transaction pooling breaks.
   */
  DIRECT_URL: z.url().optional(),

  // No JWT secret. Supabase Auth signs tokens with an ES256 key and publishes
  // the PUBLIC half at {SUPABASE_URL}/auth/v1/.well-known/jwks.json, so this
  // backend verifies signatures without holding a secret at all.

  SEED_ADMIN_EMAIL: z.email().default('operations@innovoxpress.com'),
  SEED_ADMIN_PASSWORD: z.string().min(6).default('ChangeMe!123'),
  SEED_ADMIN_NAME: z.string().default('Operations'),

  /** Supabase Storage, used for proof-of-delivery images. */
  SUPABASE_URL: z.url(),
  /** Bypasses every Supabase security rule — server-side only, never shipped. */
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  SUPABASE_STORAGE_BUCKET: z.string().min(1).default('pod'),

  // Chat attachments are a separate bucket from `pod` on purpose — POD's
  // image-only whitelist is an evidence rule, chat deliberately accepts any file.
  CHAT_STORAGE_BUCKET: z.string().min(1).default('chat-attachments'),
  CHAT_MAX_FILE_BYTES: z.coerce.number().int().positive().default(5_242_880),
  /** Seconds a generated chat attachment download link stays valid. */
  CHAT_SIGNED_URL_TTL: z.coerce.number().int().positive().default(300),

  POD_MAX_PHOTO_BYTES: z.coerce.number().int().positive().default(10_485_760),
  POD_MAX_SIGNATURE_BYTES: z.coerce.number().int().positive().default(2_097_152),
  /** Seconds a generated proof link stays valid. */
  POD_SIGNED_URL_TTL: z.coerce.number().int().positive().default(300),

  PORT: z.coerce.number().default(4000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /** Comma-separated list of browser origins allowed to call the API. */
  CORS_ORIGINS: z.string().default('http://localhost:5173'),

  // ALLOW_DRIVER_SELF_SELECT is gone. Drivers now hold real Supabase accounts,
  // so the password-free "pick your name from a list" sign-in — and the hole it
  // left open — no longer exists.

  /** How many days of GPS trail to keep. Enforced by a pg_cron job. */
  LOCATION_RETENTION_DAYS: z.coerce.number().int().positive().default(7),

  /*
   * Self-hosted OSRM — road distances and drive times, for free.
   *
   * Deliberately a plain URL with no key: this is our own process, not a metered
   * third party. It is also NOT traffic-aware; durations come from OpenStreetMap
   * speed profiles, so they order candidates correctly and understate a jam.
   *
   * The timeout is short on purpose. An operator is waiting on this to open a
   * driver list, and a stale ranking is worth far less than a list that appears —
   * so if OSRM is slow or down the caller falls back to straight-line distance
   * rather than hanging.
   */
  OSRM_URL: z.url().default('http://localhost:5000'),
  OSRM_TIMEOUT_MS: z.coerce.number().int().positive().default(4000),

  /**
   * How recently a driver must have reported to count as live on the map.
   *
   * The phone reports every few seconds whether it is moving or not, so anyone
   * running the app is always well inside this. Generous rather than tight, so a
   * driver in an underpass or a warehouse dead-spot does not blink off and on.
   */
  POSITION_LIVE_SECONDS: z.coerce.number().int().positive().default(120),

  /**
   * How far a driver must move before a fix is worth KEEPING as history.
   *
   * Only filters `driver_locations`; the live position is always overwritten. Small
   * enough to keep a trail honest, large enough that a phone sitting on a dashboard
   * does not write its own GPS jitter into the record forever.
   */
  HISTORY_MIN_MOVE_M: z.coerce.number().positive().default(15),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:', z.flattenError(parsed.error).fieldErrors);
  throw new Error('Invalid environment configuration');
}

export const env = parsed.data;

export const corsOrigins = env.CORS_ORIGINS.split(',')
  .map((o) => o.trim())
  .filter(Boolean);
