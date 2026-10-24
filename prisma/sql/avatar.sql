-- Profile photos: where a person's picture lives in the private `avatars`
-- bucket.
--
-- Here rather than in a Prisma migration for the same reason as push.sql and
-- pod.sql: `prisma db push` cannot be run against this database at all. It
-- insists on dropping `route_stops_seq_uniq`, which is DEFERRABLE and therefore
-- has no expression in Prisma's schema language, so every push would quietly
-- delete a constraint the routing code depends on.
--
-- Idempotent, like every file in this directory — applyConstraints.ts re-runs
-- the whole set on each invocation.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS "avatarPath" TEXT;
