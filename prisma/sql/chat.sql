-- =====================================================================
-- Chat — invariants, lockdown, Realtime authorization, broadcast fan-out
-- =====================================================================
--
-- Run AFTER the chat tables exist (`npm run db:push`), via `npm run db:chat`.
-- Idempotent: safe to run repeatedly.
--
-- Applied by prisma/applyConstraints.ts as ONE pool.query() — i.e. one
-- implicit transaction. Any failure rolls the whole file back, and
-- CREATE INDEX CONCURRENTLY must never appear here.
--
-- Verified against project nrphdvaeujwspfohaesu on 2026-08-16:
--   * postgres CAN create policies on realtime.messages (via
--     supabase_privileged_role — it is NOT the table owner).
--   * realtime.send(payload jsonb, event text, topic text, private boolean).
--   * realtime.topic() exists, STABLE.
--
-- ⚠️ DASHBOARD STEP, not expressible here: Realtime Settings must have
--    "Allow public access" DISABLED. Otherwise private channels are not
--    enforced and the policy below is decorative.


-- ---------------------------------------------------------------------
-- 1. Shape invariant
-- ---------------------------------------------------------------------
-- A DIRECT conversation is keyed and unnamed; a SPACE is named and unkeyed.
-- Mirrors the spirit of consignments' driver/status agreement check: code
-- guards vanish the moment someone opens the SQL editor, this does not.

ALTER TABLE chat_conversations DROP CONSTRAINT IF EXISTS chat_conversations_kind_shape;
ALTER TABLE chat_conversations ADD  CONSTRAINT chat_conversations_kind_shape CHECK (
     (type = 'DIRECT' AND "directKey" IS NOT NULL AND name IS NULL)
  OR (type = 'SPACE'  AND "directKey" IS NULL     AND name IS NOT NULL)
);


-- Attachments: all five columns describe one file, so either every one is set
-- or none is. A half-written attachment renders as a broken download with no
-- way to tell whether the object exists.
ALTER TABLE chat_messages DROP CONSTRAINT IF EXISTS chat_messages_attachment_shape;
ALTER TABLE chat_messages ADD  CONSTRAINT chat_messages_attachment_shape CHECK (
     ("attachmentPath" IS NULL AND "attachmentName" IS NULL AND "attachmentMime" IS NULL
      AND "attachmentBytes" IS NULL AND "attachmentIsImage" IS NULL)
  OR ("attachmentPath" IS NOT NULL AND "attachmentName" IS NOT NULL AND "attachmentMime" IS NOT NULL
      AND "attachmentBytes" IS NOT NULL AND "attachmentIsImage" IS NOT NULL)
);

-- A message must carry something: text, a file, or both.
ALTER TABLE chat_messages DROP CONSTRAINT IF EXISTS chat_messages_not_empty;
ALTER TABLE chat_messages ADD  CONSTRAINT chat_messages_not_empty CHECK (
  length(btrim(body)) > 0 OR "attachmentPath" IS NOT NULL
);

-- The 5 MB cap, enforced where a code change cannot bypass it. Kept in step
-- with CHAT_MAX_FILE_BYTES and the bucket's own file_size_limit.
ALTER TABLE chat_messages DROP CONSTRAINT IF EXISTS chat_messages_attachment_size;
ALTER TABLE chat_messages ADD  CONSTRAINT chat_messages_attachment_size CHECK (
  "attachmentBytes" IS NULL OR ("attachmentBytes" > 0 AND "attachmentBytes" <= 5242880)
);


-- ---------------------------------------------------------------------
-- 2. Lockdown — identical posture to the other nine tables
-- ---------------------------------------------------------------------
-- RLS on, ZERO policies, ZERO grants. The browser never reads these tables
-- directly: history comes from the Express API, live delivery comes from a
-- broadcast payload. Supabase's linter will report "RLS enabled, no policy"
-- at INFO level for all three. That is the intended state.

ALTER TABLE chat_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_members       ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages      ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON chat_conversations FROM anon, authenticated;
REVOKE ALL ON chat_members       FROM anon, authenticated;
REVOKE ALL ON chat_messages      FROM anon, authenticated;


-- ---------------------------------------------------------------------
-- 3. Realtime authorization — the ONLY policy the browser is subject to
-- ---------------------------------------------------------------------
-- Question it answers: "is this topic my own inbox?" Nothing more.
--
-- It reads NO table, so it needs no grant, no index, and it cannot be
-- broken by re-running constraints.sql (whose REVOKEs are blanket over
-- schema public).
--
-- auth.uid() returns uuid; ::text renders canonical lowercase-with-dashes,
-- exactly what session.user.id gives the client. lower() defends against a
-- client that upper-cases the topic.

DROP POLICY IF EXISTS "chat inbox read own" ON realtime.messages;
CREATE POLICY "chat inbox read own" ON realtime.messages
FOR SELECT TO authenticated
USING (
  realtime.messages.extension = 'broadcast'
  AND lower(realtime.topic()) = 'chat:' || (SELECT auth.uid())::text || ':inbox'
);

-- NOTE: deliberately no INSERT policy in v1. A browser therefore cannot
-- broadcast anything at all — Express is the only writer, so a forged
-- "chat.message.created" is impossible. Typing indicators, when we want
-- them, get a SEPARATE client-writable topic; never this one.


-- ---------------------------------------------------------------------
-- 4. Fan-out trigger — one broadcast per recipient
-- ---------------------------------------------------------------------
-- Per-user inbox topics rather than per-conversation rooms, because
-- Realtime computes channel authorization at JOIN time and caches it for
-- the life of the connection. With a per-conversation topic, removing
-- someone from a space would NOT stop them receiving its messages until
-- they disconnect. Choosing recipients per message makes removal take
-- effect on the very next send.
--
-- SECURITY INVOKER (the default) is correct: the only writer is Express,
-- connecting as postgres. Nothing here needs elevated rights, and adding a
-- SECURITY DEFINER function to schema public would be a new public RPC
-- surface (functions are EXECUTE TO PUBLIC by default).

CREATE OR REPLACE FUNCTION public.chat_broadcast_message()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
BEGIN
  PERFORM realtime.send(
    jsonb_build_object(
      'id',              NEW.id,
      'conversationId',  NEW."conversationId",
      'senderId',        NEW."senderId",
      'type',            NEW.type,
      'body',            NEW.body,
      'clientMessageId', NEW."clientMessageId",
      'createdAt',       to_char(NEW."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      -- Metadata only. The storage path never leaves the API; a client asks
      -- for a short-lived signed URL instead. Embedding a URL here would also
      -- break parity with the REST DTO, since a signed link expires.
      'attachment',      CASE
                           WHEN NEW."attachmentPath" IS NULL THEN NULL::jsonb
                           ELSE jsonb_build_object(
                             'name',    NEW."attachmentName",
                             'mime',    NEW."attachmentMime",
                             'bytes',   NEW."attachmentBytes",
                             'isImage', NEW."attachmentIsImage"
                           )
                         END
    ),
    'chat.message.created',
    'chat:' || m."userId" || ':inbox',
    true
  )
  FROM public.chat_members m
  JOIN public.users u ON u.id = m."userId"
  WHERE m."conversationId" = NEW."conversationId"
    AND u.active;
  -- No role filter. Drivers are members of dispatch DMs now, and excluding them
  -- here would deliver the message to everyone EXCEPT the person it was written
  -- for — silently, since realtime.send swallows its own failures. Membership is
  -- the only thing that decides who hears about a message; the API enforces who
  -- may become a member.
  RETURN NULL;
END;
$fn$;

-- Functions are EXECUTE TO PUBLIC by default in Postgres. This one is a
-- trigger function and cannot usefully be called directly, but revoking
-- costs nothing and keeps the RPC surface empty.
REVOKE ALL ON FUNCTION public.chat_broadcast_message() FROM PUBLIC;

CREATE OR REPLACE TRIGGER chat_messages_broadcast
AFTER INSERT ON public.chat_messages
FOR EACH ROW
EXECUTE FUNCTION public.chat_broadcast_message();


-- ---------------------------------------------------------------------
-- 5. Membership changes — the silent half of the feature
-- ---------------------------------------------------------------------
-- Being added to a space inserts a member row and no message, so without
-- this nothing is broadcast and the newcomer's sidebar stays stale until
-- they happen to refresh. Removal has the mirror problem: the space sits in
-- their list until they click it and get a 403.
--
-- Only the affected person is notified — that is all anyone needs in order
-- to refetch their own conversation list.

CREATE OR REPLACE FUNCTION public.chat_broadcast_membership()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
DECLARE
  target_user text;
  target_conv text;
  action      text;
BEGIN
  -- Branch explicitly: in a DELETE trigger NEW is unassigned, and touching it
  -- raises "record new is not assigned yet" rather than returning NULL.
  IF TG_OP = 'INSERT' THEN
    target_user := NEW."userId";
    target_conv := NEW."conversationId";
    action      := 'ADDED';
  ELSE
    target_user := OLD."userId";
    target_conv := OLD."conversationId";
    action      := 'REMOVED';
  END IF;

  PERFORM realtime.send(
    jsonb_build_object(
      'conversationId', target_conv,
      'userId',         target_user,
      'action',         action
    ),
    'chat.membership.changed',
    'chat:' || target_user || ':inbox',
    true
  );
  RETURN NULL;
END;
$fn$;

REVOKE ALL ON FUNCTION public.chat_broadcast_membership() FROM PUBLIC;

CREATE OR REPLACE TRIGGER chat_members_broadcast
AFTER INSERT OR DELETE ON public.chat_members
FOR EACH ROW
EXECUTE FUNCTION public.chat_broadcast_membership();

-- Note: deleting a conversation cascades to its members and therefore fires
-- this once per member. That is harmless — each client simply refetches a
-- list that no longer contains the row.

-- Two properties worth stating plainly:
--
--  * The realtime.send INSERT runs inside the caller's transaction, and
--    logical decoding only emits COMMITTED transactions. A rolled-back
--    send therefore broadcasts nothing — message and notification cannot
--    disagree.
--
--  * realtime.send swallows its own failures:
--        EXCEPTION WHEN OTHERS THEN RAISE WARNING 'WarnSendingBroadcastMessage: %'
--    so a broadcast failure does NOT abort the insert. The message is
--    stored and the notification silently disappears. Broadcast is
--    therefore best-effort by construction, and the client MUST reconcile
--    via GET /messages?after=<lastId> on subscribe, reconnect and
--    visibilitychange. Never let the broadcast be the sole source of truth.
--
-- The payload above must stay byte-identical in shape to the REST message
-- DTO — the client has one parser for both. createdAt is a zone-less
-- timestamp(3) holding UTC, so the to_char mask reproduces
-- Date.prototype.toJSON exactly. tests/chatRealtime.test.ts asserts this.
