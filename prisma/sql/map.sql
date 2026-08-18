-- =====================================================================
-- Dispatch map — change feed
-- =====================================================================
--
-- Run after the map columns exist, via `npm run db:map`. Idempotent.
--
-- Applied by prisma/applyConstraints.ts as ONE pool.query() — a single
-- implicit transaction. Never put CREATE INDEX CONCURRENTLY in here.
--
--
-- ⚠️ THE PAYLOAD IS AN INVALIDATION, NOT DATA. ⚠️
--
-- Every broadcast below carries exactly `{ id, op }` and must keep doing so.
-- Two reasons, and the second is load-bearing:
--
--  1. Naming columns in the trigger is a trap. `AFTER UPDATE OF status` would
--     miss a corrected receiverLat/Lng — the pin MOVES and nobody is told —
--     and item quantity lives in a different table entirely. "Refetch task X"
--     is immune to which column changed.
--
--  2. Realtime computes channel authorization when a client JOINS and caches
--     it for the life of the connection. Nobody can be promptly revoked from
--     a shared topic. So the payload must contain nothing worth stealing.
--     Do NOT add receiverName "because it is convenient" — every listener
--     would then receive every customer's name for as long as their socket
--     stays open. tests/mapRealtime.test.ts asserts this shape on purpose.


-- ---------------------------------------------------------------------
-- 1. Who counts as an operator
-- ---------------------------------------------------------------------
-- chat.sql makes a point of its policy reading no table. That works there
-- because a chat inbox topic is self-scoped by auth.uid(). A SHARED ops topic
-- cannot be: it needs an actual role check.
--
-- The JWT's app_metadata.role is the weak version of that check — it is baked
-- in at token issuance, so a demoted operator keeps ops claims until their
-- token refreshes, and join-time caching extends that further. So read the
-- source of truth, public.users.role.
--
-- constraints.sql revokes public-schema tables from `authenticated`, and an
-- RLS policy on realtime.messages evaluates as `authenticated` — hence
-- SECURITY DEFINER. This is the one such function in `public`; it is STABLE,
-- pinned to an empty search_path, takes no arguments an attacker can steer,
-- and is revoked from PUBLIC below.

CREATE OR REPLACE FUNCTION public.is_ops_user()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    WHERE u.id = (SELECT auth.uid())::text
      AND u.active
      AND u.role <> 'driver'
  )
$fn$;

-- Postgres grants EXECUTE to PUBLIC on every new function, which would make
-- this a public RPC endpoint. Close it, then open it only to authenticated.
REVOKE ALL ON FUNCTION public.is_ops_user() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_ops_user() TO authenticated;


-- ---------------------------------------------------------------------
-- 2. Who may listen to the dispatch feed
-- ---------------------------------------------------------------------
-- Topic matched with `=`, never LIKE 'dispatch:%'. A prefix predicate would
-- leak across any future per-client topic such as dispatch:tasks:<clientId>.
--
-- No INSERT policy, so a browser cannot broadcast onto this topic at all —
-- only the triggers below can.

DROP POLICY IF EXISTS "dispatch tasks read" ON realtime.messages;
CREATE POLICY "dispatch tasks read" ON realtime.messages
FOR SELECT TO authenticated
USING (
  realtime.messages.extension = 'broadcast'
  AND realtime.topic() = 'dispatch:tasks'
  AND public.is_ops_user()
);


-- ---------------------------------------------------------------------
-- 3. Task changes
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.map_broadcast_task()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
DECLARE
  task_id text;
  op      text;
BEGIN
  -- In a DELETE trigger NEW is unassigned and touching it raises, so branch.
  IF TG_OP = 'DELETE' THEN
    task_id := OLD.id;
    op      := 'delete';
  ELSE
    task_id := NEW.id;
    op      := 'upsert';
  END IF;

  PERFORM realtime.send(
    jsonb_build_object('id', task_id, 'op', op),
    'map.task.changed',
    'dispatch:tasks',
    true
  );
  RETURN NULL;
END;
$fn$;

REVOKE ALL ON FUNCTION public.map_broadcast_task() FROM PUBLIC;

-- Split in two only because a WHEN clause referencing OLD is invalid on an
-- INSERT trigger.
CREATE OR REPLACE TRIGGER map_consignments_ins_del
AFTER INSERT OR DELETE ON public.consignments
FOR EACH ROW
EXECUTE FUNCTION public.map_broadcast_task();

-- The UPDATE arm skips writes that change nothing, so a no-op save does not
-- wake every open dispatch board.
--
-- `updatedAt` MUST be excluded from that comparison. Prisma's @updatedAt sets it
-- on every single write, so the obvious `OLD.* IS DISTINCT FROM NEW.*` is always
-- true and the guard would be decorative — which is worse than having none,
-- because the next reader would believe it works. `to_jsonb(row) - 'key'` drops
-- the column before comparing.
CREATE OR REPLACE TRIGGER map_consignments_upd
AFTER UPDATE ON public.consignments
FOR EACH ROW
WHEN (to_jsonb(OLD) - 'updatedAt' IS DISTINCT FROM to_jsonb(NEW) - 'updatedAt')
EXECUTE FUNCTION public.map_broadcast_task();


-- ---------------------------------------------------------------------
-- 4. Item changes — the widget shows a quantity
-- ---------------------------------------------------------------------
-- Editing a consignment replaces its items (deleteMany + re-create), so these
-- arrive as a burst for one task. The client must coalesce by id.
--
-- Always 'upsert': the parent still exists in every case except a cascade from
-- a deleted consignment, and that fires the delete above as well. A client
-- that refetches and gets a 404 should treat it as a removal.

CREATE OR REPLACE FUNCTION public.map_broadcast_task_items()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
DECLARE
  task_id text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    task_id := OLD."consignmentId";
  ELSE
    task_id := NEW."consignmentId";
  END IF;

  PERFORM realtime.send(
    jsonb_build_object('id', task_id, 'op', 'upsert'),
    'map.task.changed',
    'dispatch:tasks',
    true
  );
  RETURN NULL;
END;
$fn$;

REVOKE ALL ON FUNCTION public.map_broadcast_task_items() FROM PUBLIC;

CREATE OR REPLACE TRIGGER map_items_changed
AFTER INSERT OR UPDATE OR DELETE ON public.items
FOR EACH ROW
EXECUTE FUNCTION public.map_broadcast_task_items();

-- Reminder, as in chat.sql: realtime.send swallows its own failures with a
-- RAISE WARNING, so delivery is best-effort. Clients must refetch on subscribe,
-- on reconnect and on visibilitychange — those three are the safety net, not
-- the mechanism.
