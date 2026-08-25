-- Run once against the database after `prisma db push` / `prisma migrate deploy`.
-- Safe to re-run: each constraint is dropped first.
--
-- Why this lives in SQL and not in application code: a guard that exists only in
-- the service layer disappears the moment anyone writes through the Supabase SQL
-- editor, a seed script, or a future worker.

-- A driver and the status must agree. An order is UNASSIGNED if and only if it
-- has no driver, so "assigned but driverless" and "unassigned but has a driver"
-- are both unrepresentable.
ALTER TABLE consignments DROP CONSTRAINT IF EXISTS consignments_driver_status_agree;
ALTER TABLE consignments ADD CONSTRAINT consignments_driver_status_agree
  CHECK (("driverId" IS NULL) = (status = 'UNASSIGNED'));

-- Quantities are positive.
ALTER TABLE items DROP CONSTRAINT IF EXISTS items_qty_positive;
ALTER TABLE items ADD CONSTRAINT items_qty_positive
  CHECK (qty >= 1);

-- Weight, when supplied, is never negative.
ALTER TABLE items DROP CONSTRAINT IF EXISTS items_weight_non_negative;
ALTER TABLE items ADD CONSTRAINT items_weight_non_negative
  CHECK ("weightKg" IS NULL OR "weightKg" >= 0);

-- The delivery window cannot close before it opens.
ALTER TABLE consignments DROP CONSTRAINT IF EXISTS consignments_window_ordered;
ALTER TABLE consignments ADD CONSTRAINT consignments_window_ordered
  CHECK ("readyBy" IS NULL OR "deliverBy" IS NULL OR "deliverBy" >= "readyBy");

-- Address text (city / province / postal code) is deliberately unconstrained.
-- The console fills it from the geocoder and lets the operator overrule it; the
-- coordinate is what the system routes on, so a CHECK here would only block a
-- dispatcher who knows better than TomTom does.

-- ---------------------------------------------------------------------------
-- Lock the public schema down (Supabase)
-- ---------------------------------------------------------------------------
-- Supabase exposes every table in the `public` schema through PostgREST, which
-- accepts the anon/publishable key — a key that is public by design and ships in
-- any frontend bundle. Without this block, all consignment, client and user data
-- is readable and writable by anyone who knows the project URL.
--
-- This app does not use PostgREST, Supabase Auth, or RLS-based authorization:
-- everything goes through the Express backend as the `postgres` role, which has
-- rolbypassrls = true. So enabling RLS with NO policies is a total deny for
-- outside clients and a complete no-op for us.
--
-- Supabase's linter will report these tables as "RLS enabled, no policy" at INFO
-- level. That is the intended state here, not an oversight.

ALTER TABLE clients            ENABLE ROW LEVEL SECURITY;
ALTER TABLE drivers            ENABLE ROW LEVEL SECURITY;
ALTER TABLE users              ENABLE ROW LEVEL SECURITY;
ALTER TABLE consignments       ENABLE ROW LEVEL SECURITY;
ALTER TABLE items              ENABLE ROW LEVEL SECURITY;
ALTER TABLE proofs_of_delivery ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracking_events    ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_counters     ENABLE ROW LEVEL SECURITY;
ALTER TABLE driver_locations   ENABLE ROW LEVEL SECURITY;

-- Defence in depth: even if RLS were later switched off on some table by
-- accident, the PostgREST roles hold no privileges on it at all.
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;

-- Same treatment for anything created in this schema later.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- GPS trail retention
-- ---------------------------------------------------------------------------
-- driver_locations is the only table here that grows without bound: one row
-- every few seconds per driver on shift is ~2,900 rows per driver per day.
-- Unpruned that is millions of rows a year, which eventually slows the trail
-- query and costs storage for data nobody reads.
--
-- Seven days is long enough to replay a disputed delivery and short enough to
-- keep the table small.

CREATE EXTENSION IF NOT EXISTS pg_cron;

CREATE OR REPLACE FUNCTION prune_driver_locations()
RETURNS void
LANGUAGE sql
AS $$
  DELETE FROM driver_locations
  WHERE "recordedAt" < now() - interval '7 days';
$$;

-- Re-scheduling with the same name replaces the existing job, so this stays
-- idempotent alongside the rest of the file.
SELECT cron.schedule(
  'prune-driver-locations',
  '17 3 * * *',            -- 03:17 daily, off the hour to avoid the busy minute
  $$SELECT prune_driver_locations()$$
);

-- ---------------------------------------------------------------------------
-- Clock everyone off overnight
-- ---------------------------------------------------------------------------
-- `onShift` is what makes a driver assignable, and it is set by the driver from
-- their phone. A shift does not carry across days, and a courier who forgets to
-- tap "off shift" must not appear available all week — an operator would keep
-- assigning work to someone who went home on Tuesday.
--
-- This is the same class of problem that makes "delete the driver when he is
-- inactive" unsafe: a stale flag is indistinguishable from a true one.

-- The close time is stamped here too, so an auto-closed shift is still a shift
-- with two ends. 04:00 is a fiction — nobody stopped working then — so prefer the
-- driver's last GPS ping, which is the last moment we have evidence they were
-- actually out there, and fall back to now() for a driver who reported nothing.
--
-- `shiftStartedAt` is left alone: clearing it would leave a close time with no
-- matching open time, which cannot answer "how long was that shift?".
--
-- Written UTC-explicitly because these columns are `timestamp` without time zone
-- and Prisma stores UTC wall-clock in them; a bare now() would depend on the
-- session TimeZone.
CREATE OR REPLACE FUNCTION reset_driver_shifts()
RETURNS void
LANGUAGE sql
-- Empty search_path with every name qualified: the linter flags a mutable one,
-- and a cron job running as `postgres` is exactly where resolution should not
-- depend on whoever's session settings happen to apply.
SET search_path = ''
AS $$
  UPDATE public.drivers d
  SET "onShift" = false,
      "shiftEndedAt" = COALESCE(
        (SELECT max(l."recordedAt")
           FROM public.driver_locations l
          WHERE l."driverId" = d.id
            AND l."recordedAt" >= COALESCE(d."shiftStartedAt", now() AT TIME ZONE 'utc' - interval '1 day')),
        now() AT TIME ZONE 'utc'
      ),
      "updatedAt" = now() AT TIME ZONE 'utc'
  WHERE d."onShift" = true;
$$;

SELECT cron.schedule(
  'reset-driver-shifts',
  '0 4 * * *',             -- 04:00 daily, before any realistic start of shift
  $$SELECT reset_driver_shifts()$$
);
