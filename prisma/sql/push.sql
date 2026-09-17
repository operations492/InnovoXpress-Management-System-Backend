-- ---------------------------------------------------------------------
-- Push notification delivery address
-- ---------------------------------------------------------------------
--
-- Applied here rather than by `prisma db push`, which cannot be run against this
-- database: it diffs the whole schema and proposes dropping `route_stops_seq_uniq`,
-- a DEFERRABLE unique constraint that Prisma has no syntax for. See prisma/sql/pod.sql.
--
-- Idempotent, so re-running is a no-op and a fresh environment gets the column
-- without anyone remembering a one-off command.

-- An Expo push token — `ExponentPushToken[...]`. Nullable because most rows will
-- never have one: operators work in a browser, and a driver who has not opened
-- the app yet has nowhere to push to.
--
-- Not a secret and not an identity. It is a delivery address the OS may rotate at
-- any time, so it is overwritten on every sign-in and cleared on sign-out.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS "pushToken" TEXT;
