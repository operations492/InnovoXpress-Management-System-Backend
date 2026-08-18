-- =====================================================================
-- Planned routes — constraints Prisma cannot express
-- =====================================================================
--
-- Run after the route tables exist, via `npm run db:routes`. Idempotent.
--
-- Applied by prisma/applyConstraints.ts as ONE pool.query() — a single implicit
-- transaction. Never put CREATE INDEX CONCURRENTLY in here.
--
-- Everything below is enforcement the application cannot skip. A rule that lives
-- only in a service holds until the next endpoint, the next migration, or the next
-- hand-run SQL fix; a rule that lives here holds for all of them.


-- ---------------------------------------------------------------------
-- 1. One live plan per driver
-- ---------------------------------------------------------------------
-- Superseded routes are kept — last week's plan is worth being able to read — so
-- this is a PARTIAL index rather than a plain unique on driverId. Prisma has no
-- syntax for a WHERE clause on a unique index, hence raw SQL.

CREATE UNIQUE INDEX IF NOT EXISTS routes_one_active_per_driver
  ON public.routes ("driverId")
  WHERE status = 'ACTIVE';


-- ---------------------------------------------------------------------
-- 2. No two stops may claim the same position
-- ---------------------------------------------------------------------
-- DEFERRABLE is the whole point, and it is why this is not a Prisma @@unique.
--
-- Reordering rewrites most of the sequence at once: moving stop 7 to position 3
-- shifts 3,4,5,6 down by one. Applied row by row against an immediately-checked
-- constraint, the very first UPDATE collides with a row that has not moved yet, so
-- the usual workarounds are temporary negative numbers or a delete-and-reinsert.
-- Deferring the check to COMMIT lets the whole permutation be written plainly and
-- still guarantees the end state is valid.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'route_stops_seq_uniq'
  ) THEN
    ALTER TABLE public.route_stops
      ADD CONSTRAINT route_stops_seq_uniq
      UNIQUE ("routeId", seq) DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;


-- ---------------------------------------------------------------------
-- 3. A stop must sit somewhere real, at a sane position
-- ---------------------------------------------------------------------
-- (0,0) is in the Gulf of Guinea and is what a failed geocode leaves behind. A
-- plan built around it is not a plan.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'route_stops_seq_positive') THEN
    ALTER TABLE public.route_stops ADD CONSTRAINT route_stops_seq_positive CHECK (seq >= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'route_stops_coords_sane') THEN
    ALTER TABLE public.route_stops ADD CONSTRAINT route_stops_coords_sane CHECK (
      "plannedLat" BETWEEN -90 AND 90
      AND "plannedLng" BETWEEN -180 AND 180
      AND NOT ("plannedLat" = 0 AND "plannedLng" = 0)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'routes_start_sane') THEN
    ALTER TABLE public.routes ADD CONSTRAINT routes_start_sane CHECK (
      "startLat" BETWEEN -90 AND 90
      AND "startLng" BETWEEN -180 AND 180
      AND NOT ("startLat" = 0 AND "startLng" = 0)
    );
  END IF;
END $$;


-- ---------------------------------------------------------------------
-- 4. Lock the tables down like every other
-- ---------------------------------------------------------------------
-- RLS on with no policies, matching the rest of `public`: Supabase publishes these
-- through PostgREST with a public anon key, and this closes that door. The backend
-- connects as `postgres` and bypasses RLS.

ALTER TABLE public.routes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.route_stops ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.routes      FROM anon, authenticated;
REVOKE ALL ON TABLE public.route_stops FROM anon, authenticated;
