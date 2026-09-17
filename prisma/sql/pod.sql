-- ---------------------------------------------------------------------
-- Proof of delivery — columns Prisma cannot deliver on this database
-- ---------------------------------------------------------------------
--
-- These two are ordinary nullable columns and belong to schema.prisma, which
-- declares them. They are repeated here because `prisma db push` cannot be run
-- against this database: it diffs the WHOLE schema, and the raw SQL in
-- routes.sql and positions.sql has built things Prisma's model cannot express.
-- Asked to reconcile, it proposes
--
--     DROP INDEX "route_stops_seq_uniq";
--
-- because `UNIQUE (...) DEFERRABLE INITIALLY DEFERRED` has no Prisma syntax, so
-- Prisma sees an index it did not create and removes it. Postgres refuses —
-- it backs a constraint — and the push aborts before reaching anything else.
-- That refusal is doing us a favour: dropping it would leave route reordering
-- silently broken, because the whole point of deferring the check is that a
-- permutation collides with itself until COMMIT.
--
-- So the column is applied here instead, through the same idempotent pipeline as
-- every other piece of hand-written DDL in this project. Running it twice is a
-- no-op, and a fresh environment gets the columns without anyone remembering a
-- one-off command.
--
-- The real fix is to reconcile the drift — four missing foreign keys on
-- driver_positions, routes and route_stops, plus the routes.createdAt default —
-- and that is a separate, deliberate piece of work, not something to let a
-- schema push do by surprise.

-- Who handed the parcel over (PICKUP) or took it in (DELIVERY).
ALTER TABLE public.proofs_of_delivery
  ADD COLUMN IF NOT EXISTS "signedByName" TEXT;

-- How many pieces the driver counted at this stop.
--
-- Deliberately unconstrained against the order's own total: a short handover is
-- the most useful thing a driver can report, and a column that only accepted the
-- expected number would force them to record a figure they know is wrong. The
-- app confirms the discrepancy with the driver; this stores what they stood by.
ALTER TABLE public.proofs_of_delivery
  ADD COLUMN IF NOT EXISTS "itemCount" INTEGER;
