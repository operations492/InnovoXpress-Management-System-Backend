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

  /// Driver photo + ID card. A third private bucket rather than reusing `pod`:
  /// POD object paths are deliberately guessable and the two have nothing to do
  /// with each other, so one mistake should not expose both.
  DRIVER_DOCS_BUCKET: z.string().min(1).default('driver-docs'),
  DRIVER_DOCS_MAX_BYTES: z.coerce.number().int().positive().default(10_485_760),
  /// Must outlast the console roster poll, or faces go blank between refetches.
  DRIVER_DOCS_SIGNED_URL_TTL: z.coerce.number().int().positive().default(3_600),

  /// Release letters attached to an order. A fourth private bucket for the same
  /// reason the third one exists: this is customer paperwork, not evidence, and
  /// it accepts PDFs, so mixing it into `pod` would weaken POD's image-only rule.
  ORDER_DOCS_BUCKET: z.string().min(1).default('order-docs'),
  ORDER_DOCS_MAX_BYTES: z.coerce.number().int().positive().default(10_485_760),
  /// Long on purpose: a driver opens this standing at a cargo desk on one bar of
  /// signal, and a link that expires mid-handover is worse than useless.
  ORDER_DOCS_SIGNED_URL_TTL: z.coerce.number().int().positive().default(3_600),
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
   * Google Routes — road distances, drive times and optimised stop order.
   *
   * Replaced self-hosted OSRM. The trade is money for truth: this one IS
   * traffic-aware, so an ETA finally means something at 5pm, but every call is
   * billed and billed again for every field requested. Hence the four knobs
   * below, which exist to stop a loop becoming an invoice.
   *
   * Defaults to empty so the app boots and degrades (straight-line distance, no
   * drawn line) before a key exists, rather than refusing to start.
   */
  GOOGLE_ROUTES_API_KEY: z.string().default(''),
  /**
   * Short on purpose. An operator is waiting on this to open a driver list, and a
   * stale ranking is worth far less than a list that appears.
   */
  GOOGLE_ROUTES_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  /**
   * `TRAFFIC_AWARE` is the middle SKU and the right default. `TRAFFIC_UNAWARE` is
   * cheapest and fine for ordering; `TRAFFIC_AWARE_OPTIMAL` costs materially more
   * for a marginally better answer.
   */
  GOOGLE_ROUTES_TRAFFIC: z
    .enum(['TRAFFIC_UNAWARE', 'TRAFFIC_AWARE', 'TRAFFIC_AWARE_OPTIMAL'])
    .default('TRAFFIC_AWARE'),
  /**
   * How long a drawn line may be reused. An hour, because a planned route's roads
   * do not change and this is the call the system makes most — once per read of
   * every saved route.
   */
  GOOGLE_ROUTES_CACHE_TTL_MS: z.coerce.number().int().positive().default(3_600_000),
  /** Much shorter: drivers move, so a ranking goes stale in a way geometry does not. */
  GOOGLE_MATRIX_CACHE_TTL_MS: z.coerce.number().int().positive().default(60_000),
  /**
   * Hard stop on calls per day. Reached, the engine reads as unavailable and the
   * app degrades exactly as it did when OSRM was down — which is the point: an
   * outage is visible and recoverable, a surprise bill is neither.
   */
  GOOGLE_ROUTES_DAILY_BUDGET: z.coerce.number().int().positive().default(2_500),
  /**
   * Google moves at most this many intermediate waypoints. Well below OSRM's 100,
   * so a planned route now caps here — raise it only if the plan allows.
   */
  GOOGLE_ROUTES_MAX_WAYPOINTS: z.coerce.number().int().positive().default(25),

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
