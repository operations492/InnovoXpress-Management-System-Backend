-- =====================================================================
-- Live driver positions — push feed
-- =====================================================================
--
-- Run after `driver_positions` exists, via `npm run db:positions`. Idempotent.
--
-- Applied by prisma/applyConstraints.ts as ONE pool.query() — a single implicit
-- transaction. Never put CREATE INDEX CONCURRENTLY in here.
--
-- Depends on public.is_ops_user(), created by map.sql.
--
--
-- ⚠️ THIS PAYLOAD CARRIES DATA, UNLIKE map.sql's ⚠️
--
-- map.sql broadcasts `{id, op}` and makes the reader refetch, because its rows
-- contain customer names and addresses. This one deliberately carries the whole
-- position, and the difference is not laziness:
--
--   * The payload IS the entire state — driverId, lat, lng, heading, speed,
--     timestamp. There is nothing left to fetch, so an invalidation would force a
--     round trip per event and end up SLOWER than the polling it replaces.
--   * A position arrives several times a second per driver. Refetching the whole
--     roster on each one would be pathological.
--
-- The cost, stated plainly: Realtime computes channel authorization when a client
-- JOINS and caches it for the life of the socket, so an operator demoted mid-shift
-- keeps receiving driver positions until their connection closes. That is accepted
-- here — these are the company's own drivers, not customer data — and it is exactly
-- why nothing about a CONSIGNMENT may ever be added to this payload.


-- ---------------------------------------------------------------------
-- 1. Who may listen
-- ---------------------------------------------------------------------
-- Exact topic match, never LIKE 'dispatch:%' — a prefix predicate would leak
-- across any future per-client topic.
--
-- No INSERT policy, so a browser cannot broadcast onto this topic; only the
-- trigger below can.

DROP POLICY IF EXISTS "dispatch drivers read" ON realtime.messages;
CREATE POLICY "dispatch drivers read" ON realtime.messages
FOR SELECT TO authenticated
USING (
  realtime.messages.extension = 'broadcast'
  AND realtime.topic() = 'dispatch:drivers'
  AND public.is_ops_user()
);


-- ---------------------------------------------------------------------
-- 2. The feed
-- ---------------------------------------------------------------------
-- Fires on INSERT and UPDATE of the one row per driver. No DELETE arm: a position
-- is never deleted in normal operation, and a driver being removed cascades from
-- `drivers`, which the console learns about from the roster.
--
-- The driver's NAME is included so a client can render a pin without holding the
-- roster in memory — it is already visible to every operator on the map and in the
-- assign list, so it leaks nothing the topic does not already imply.
--
-- `onShift` and `active` are checked here rather than in the client: a driver who
-- clocked off should stop appearing immediately, and the alternative is every
-- listener filtering correctly forever.

CREATE OR REPLACE FUNCTION public.broadcast_driver_position()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
DECLARE
  drv record;
BEGIN
  SELECT d.name, d.active, d."onShift", d."mapColorIndex"
    INTO drv
    FROM public.drivers d
   WHERE d.id = NEW."driverId";

  -- Nothing to say about someone who has left or clocked off. Their pin ages out
  -- of the live window on its own, so silence is the correct signal.
  IF drv IS NULL OR NOT drv.active OR NOT drv."onShift" THEN
    RETURN NULL;
  END IF;

  PERFORM realtime.send(
    jsonb_build_object(
      'driverId',   NEW."driverId",
      'name',       drv.name,
      'colorIndex', drv."mapColorIndex",
      'lat',        NEW.lat,
      'lng',        NEW.lng,
      'accuracyM',  NEW."accuracyM",
      'speedMps',   NEW."speedMps",
      'headingDeg', NEW."headingDeg",
      'recordedAt', NEW."recordedAt"
    ),
    'driver.position',
    'dispatch:drivers',
    true
  );
  RETURN NULL;
END;
$fn$;

REVOKE ALL ON FUNCTION public.broadcast_driver_position() FROM PUBLIC;

CREATE OR REPLACE TRIGGER driver_position_changed
AFTER INSERT OR UPDATE ON public.driver_positions
FOR EACH ROW
EXECUTE FUNCTION public.broadcast_driver_position();


-- ---------------------------------------------------------------------
-- 3. Lock the table down like every other
-- ---------------------------------------------------------------------
-- RLS on with no policies, matching the rest of `public`: Supabase publishes these
-- tables through PostgREST with a public anon key, and this closes that door. The
-- backend connects as `postgres` and bypasses RLS.

ALTER TABLE public.driver_positions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.driver_positions FROM anon, authenticated;


-- Reminder, as in map.sql and chat.sql: realtime.send swallows its own failures
-- with a RAISE WARNING, so delivery is best-effort. The console keeps a slow poll
-- underneath — that is the safety net, not the mechanism.
