-- ---------------------------------------------------------------------
-- Accessorials attached to an order
-- ---------------------------------------------------------------------
--
-- Applied here rather than by `prisma db push`, for the reason given in
-- prisma/sql/invoices.sql: a push against this database proposes dropping
-- `fsa_boundaries` and several other things that have nothing to do with the
-- change being made.
--
-- A join table and not a column, because an order can need several charges.
-- It stores which charge applies and never how much: the price comes from the
-- customer's rate card on the day the job is invoiced.
--
-- Idempotent, so re-running is a no-op.

CREATE TABLE IF NOT EXISTS public.consignment_services (
  "id"                  TEXT         NOT NULL,
  "consignmentId"       TEXT         NOT NULL,
  "additionalServiceId" TEXT         NOT NULL,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "consignment_services_pkey" PRIMARY KEY ("id")
);

-- Ticking the same box twice is one charge, not two.
CREATE UNIQUE INDEX IF NOT EXISTS "consignment_services_consignmentId_additionalServiceId_key"
  ON public.consignment_services("consignmentId", "additionalServiceId");

CREATE INDEX IF NOT EXISTS "consignment_services_consignmentId_idx"
  ON public.consignment_services("consignmentId");

-- Cascade: the charges are part of the order, not records in their own right.
DO $$ BEGIN
  ALTER TABLE public.consignment_services
    ADD CONSTRAINT "consignment_services_consignmentId_fkey"
    FOREIGN KEY ("consignmentId") REFERENCES public.consignments("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Restrict: a charge applied to real work cannot be deleted out from under it,
-- only deactivated — the same rule service levels follow.
DO $$ BEGIN
  ALTER TABLE public.consignment_services
    ADD CONSTRAINT "consignment_services_additionalServiceId_fkey"
    FOREIGN KEY ("additionalServiceId") REFERENCES public.additional_services("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Enabled with no policies, like every other application table: the backend
-- connects as `postgres` and bypasses RLS, PostgREST on the anon key gets
-- nothing. The linter's "RLS enabled, no policy" notice is the intended state.
ALTER TABLE public.consignment_services ENABLE ROW LEVEL SECURITY;
