-- ---------------------------------------------------------------------
-- Orders logged without picking a client
-- ---------------------------------------------------------------------
--
-- Applied here rather than by `prisma db push`, for the reason given in
-- prisma/sql/invoices.sql: a push against this database proposes dropping
-- `fsa_boundaries` and other things unrelated to the change.
--
-- An order with no picked client still belongs to a real client row — the
-- built-in Walk-in account, created on first use by the service — so the
-- order number ({CODE}-{date}-{seq}), the per-client reference rule and every
-- join on clients keep working. This column holds the customer name the
-- operator typed instead. It is null for orders of a named client.
--
-- Additive and idempotent: one nullable column, nothing dropped or rewritten.

ALTER TABLE public.consignments
  ADD COLUMN IF NOT EXISTS "customerName" TEXT;
