-- ---------------------------------------------------------------------
-- Invoicing
-- ---------------------------------------------------------------------
--
-- Applied here rather than by `prisma db push`, for the reason given in
-- prisma/sql/pod.sql and prisma/sql/push.sql: a push against this database
-- diffs the whole schema and proposes, among other things, dropping
-- `fsa_boundaries` (the 1,643 Canadian FSA polygons the entire zone system
-- reads), `route_rates_from_zone_backup`, `users."avatarPath"` and the
-- DEFERRABLE unique constraint `route_stops_seq_uniq`. None of those are part
-- of this change, and losing the boundary table would silently break every
-- postcode-to-zone lookup in pricing.
--
-- Everything below is idempotent, so re-running is a no-op and a fresh
-- environment gets the whole invoicing schema without anyone remembering a
-- one-off command.

-- --------------------------------------------------------------------- enums

-- CREATE TYPE has no IF NOT EXISTS before PG 16, so each is guarded.
DO $$ BEGIN
  CREATE TYPE "InvoiceStatus" AS ENUM ('OPEN', 'CLOSED', 'APPROVED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "PriceLineKind" AS ENUM
    ('BASE', 'DISTANCE', 'WAITING', 'SERVICE', 'LEVY', 'TAX', 'MANUAL');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ------------------------------------------------------- columns on existing

-- Exemption belongs to the customer; a rate belongs to the jurisdiction. Kept
-- apart because they change for different reasons.
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS "taxExempt"        BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "paymentTermsDays" INTEGER NOT NULL DEFAULT 30;

-- Half of the rate card's price key, alongside service level and destination
-- zone. Nullable: matching is loose, so a rate whose service level and zone
-- match still applies when this is empty.
ALTER TABLE public.consignments
  ADD COLUMN IF NOT EXISTS "freightItemId" TEXT;

DO $$ BEGIN
  ALTER TABLE public.consignments
    ADD CONSTRAINT "consignments_freightItemId_fkey"
    FOREIGN KEY ("freightItemId") REFERENCES public.freight_items("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "consignments_freightItemId_idx"
  ON public.consignments("freightItemId");

-- ------------------------------------------------------------------- tables

CREATE TABLE IF NOT EXISTS public.invoices (
  "id"           TEXT          NOT NULL,
  "number"       TEXT          NOT NULL,
  "clientId"     TEXT          NOT NULL,
  "invoiceDate"  TIMESTAMP(3)  NOT NULL,
  "dueDate"      TIMESTAMP(3)  NOT NULL,
  "status"       "InvoiceStatus" NOT NULL DEFAULT 'OPEN',
  "currency"     TEXT          NOT NULL DEFAULT 'CAD',
  -- Snapshot. A later rate change is a fact about the future, not about
  -- invoices already sent.
  "taxPct"       DECIMAL(5,2)  NOT NULL DEFAULT 0,
  "createdById"  TEXT          NOT NULL,
  "approvedById" TEXT,
  "approvedAt"   TIMESTAMP(3),
  -- Denormalised, recomputed from the lines on every mutation: the list screen
  -- paints five money columns per row, and summing three tables per row to do
  -- that is how a grid dies.
  "baseTotal"    DECIMAL(12,2) NOT NULL DEFAULT 0,
  "serviceTotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "levyTotal"    DECIMAL(12,2) NOT NULL DEFAULT 0,
  "taxTotal"     DECIMAL(12,2) NOT NULL DEFAULT 0,
  "grandTotal"   DECIMAL(12,2) NOT NULL DEFAULT 0,
  "notes"        TEXT,
  "createdAt"    TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3)  NOT NULL,
  CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS public.invoice_lines (
  "id"            TEXT          NOT NULL,
  "invoiceId"     TEXT          NOT NULL,
  "consignmentId" TEXT          NOT NULL,
  "rateCardId"    TEXT,
  "levyPct"       DECIMAL(5,2)  NOT NULL DEFAULT 0,
  -- Null means the figure could not be established, which is different from
  -- zero and prints blank rather than as "0 km".
  "distanceKm"    DECIMAL(10,2),
  "waitMinutes"   INTEGER,
  "baseAmount"    DECIMAL(12,2) NOT NULL DEFAULT 0,
  "serviceAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "levyAmount"    DECIMAL(12,2) NOT NULL DEFAULT 0,
  "taxAmount"     DECIMAL(12,2) NOT NULL DEFAULT 0,
  "grandTotal"    DECIMAL(12,2) NOT NULL DEFAULT 0,
  "ratingNotes"   TEXT,
  "edited"        BOOLEAN       NOT NULL DEFAULT false,
  "createdAt"     TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3)  NOT NULL,
  CONSTRAINT "invoice_lines_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS public.invoice_price_lines (
  "id"            TEXT          NOT NULL,
  "invoiceLineId" TEXT          NOT NULL,
  "kind"          "PriceLineKind" NOT NULL,
  "key"           TEXT          NOT NULL,
  "label"         TEXT          NOT NULL,
  "detail"        TEXT,
  "amount"        DECIMAL(12,2) NOT NULL,
  "sortOrder"     INTEGER       NOT NULL DEFAULT 0,
  -- Only the base-side rows. Levy and tax are percentages of something else:
  -- typing over them would make the invoice disagree with its own arithmetic.
  "editable"      BOOLEAN       NOT NULL DEFAULT false,
  CONSTRAINT "invoice_price_lines_pkey" PRIMARY KEY ("id")
);

-- Exactly one row. A table rather than env vars because the tax rate and the
-- invoice counter both change at runtime, by an admin, without a deploy.
CREATE TABLE IF NOT EXISTS public.finance_settings (
  "id"                TEXT         NOT NULL DEFAULT 'default',
  "taxPct"            DECIMAL(5,2) NOT NULL DEFAULT 13,
  "invoicePrefix"     TEXT         NOT NULL DEFAULT '',
  "invoiceNextNumber" INTEGER      NOT NULL DEFAULT 1000,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "finance_settings_pkey" PRIMARY KEY ("id")
);

-- The single row, created only if the table is empty so a re-run never resets
-- a counter that has already handed out numbers.
INSERT INTO public.finance_settings ("id", "updatedAt")
  VALUES ('default', NOW())
  ON CONFLICT ("id") DO NOTHING;

-- ------------------------------------------------------------------ indexes

CREATE UNIQUE INDEX IF NOT EXISTS "invoices_number_key"
  ON public.invoices("number");
CREATE INDEX IF NOT EXISTS "invoices_clientId_status_idx"
  ON public.invoices("clientId", "status");
CREATE INDEX IF NOT EXISTS "invoices_invoiceDate_idx"
  ON public.invoices("invoiceDate");
CREATE INDEX IF NOT EXISTS "invoices_status_idx"
  ON public.invoices("status");

-- Unique across the whole table, not merely within one invoice: a job belongs
-- to one invoice or to none, and the database is the right place to say so.
CREATE UNIQUE INDEX IF NOT EXISTS "invoice_lines_consignmentId_key"
  ON public.invoice_lines("consignmentId");
CREATE INDEX IF NOT EXISTS "invoice_lines_invoiceId_idx"
  ON public.invoice_lines("invoiceId");

CREATE INDEX IF NOT EXISTS "invoice_price_lines_invoiceLineId_sortOrder_idx"
  ON public.invoice_price_lines("invoiceLineId", "sortOrder");

-- -------------------------------------------------------------- foreign keys

DO $$ BEGIN
  ALTER TABLE public.invoices
    ADD CONSTRAINT "invoices_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES public.clients("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.invoices
    ADD CONSTRAINT "invoices_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES public.users("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.invoices
    ADD CONSTRAINT "invoices_approvedById_fkey"
    FOREIGN KEY ("approvedById") REFERENCES public.users("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.invoice_lines
    ADD CONSTRAINT "invoice_lines_invoiceId_fkey"
    FOREIGN KEY ("invoiceId") REFERENCES public.invoices("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Restrict, not Cascade: deleting an order must not quietly remove it from an
-- invoice that has already been sent.
DO $$ BEGIN
  ALTER TABLE public.invoice_lines
    ADD CONSTRAINT "invoice_lines_consignmentId_fkey"
    FOREIGN KEY ("consignmentId") REFERENCES public.consignments("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- SetNull: deleting a rate card loses the audit pointer, never the money.
DO $$ BEGIN
  ALTER TABLE public.invoice_lines
    ADD CONSTRAINT "invoice_lines_rateCardId_fkey"
    FOREIGN KEY ("rateCardId") REFERENCES public.rate_cards("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.invoice_price_lines
    ADD CONSTRAINT "invoice_price_lines_invoiceLineId_fkey"
    FOREIGN KEY ("invoiceLineId") REFERENCES public.invoice_lines("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ----------------------------------------------------------------------- RLS

-- Enabled with no policies, exactly like every other application table: the
-- backend connects as `postgres` and bypasses RLS, while PostgREST on the
-- public anon key gets nothing. The linter's "RLS enabled, no policy" notice
-- is the intended state.
ALTER TABLE public.invoices            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_lines       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_price_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_settings    ENABLE ROW LEVEL SECURITY;
