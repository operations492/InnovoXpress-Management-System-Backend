-- ---------------------------------------------------------------------
-- Invoice email history
-- ---------------------------------------------------------------------
--
-- Applied here rather than by `prisma db push`, for the reason given in
-- prisma/sql/invoices.sql: a push against this database proposes dropping
-- `fsa_boundaries` and other things unrelated to the change.
--
-- One row per email of an invoice. A history and not a flag on the invoice,
-- because invoices are re-sent, and "to whom, by whom, when" is the question
-- that comes back weeks later.
--
-- Additive and idempotent: a new table, its index and foreign keys.

CREATE TABLE IF NOT EXISTS public.invoice_sends (
  "id"        TEXT         NOT NULL,
  "invoiceId" TEXT         NOT NULL,
  "toEmails"  TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
  "ccEmails"  TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
  "sentById"  TEXT         NOT NULL,
  "messageId" TEXT,
  "sentAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "invoice_sends_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "invoice_sends_invoiceId_sentAt_idx"
  ON public.invoice_sends("invoiceId", "sentAt");

-- Cascade: the history belongs to the invoice.
DO $$ BEGIN
  ALTER TABLE public.invoice_sends
    ADD CONSTRAINT "invoice_sends_invoiceId_fkey"
    FOREIGN KEY ("invoiceId") REFERENCES public.invoices("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Restrict: who sent a customer an invoice must not vanish with an account.
DO $$ BEGIN
  ALTER TABLE public.invoice_sends
    ADD CONSTRAINT "invoice_sends_sentById_fkey"
    FOREIGN KEY ("sentById") REFERENCES public.users("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Enabled with no policies, like every other application table.
ALTER TABLE public.invoice_sends ENABLE ROW LEVEL SECURITY;
