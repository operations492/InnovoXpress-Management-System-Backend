import { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma.js';

/*
 * Every database call for chat lives here. The service layer never imports
 * prisma — including its error types, which is why the P2002 races below are
 * caught in this file rather than one layer up.
 */

/* ------------------------------------------------------------------ */
/* selects                                                             */
/* ------------------------------------------------------------------ */

const conversationSelect = {
  id: true,
  type: true,
  name: true,
  description: true,
  directKey: true,
  createdById: true,
  lastMessageAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ChatConversationSelect;

const memberSelect = {
  conversationId: true,
  userId: true,
  role: true,
  joinedAt: true,
  lastReadAt: true,
} satisfies Prisma.ChatMemberSelect;

const messageSelect = {
  id: true,
  conversationId: true,
  senderId: true,
  type: true,
  body: true,
  clientMessageId: true,
  createdAt: true,
  // Attachment metadata travels with the message; `attachmentPath` never does
  // — it is server-only, and clients ask for a signed URL instead.
  attachmentName: true,
  attachmentMime: true,
  attachmentBytes: true,
  attachmentIsImage: true,
} satisfies Prisma.ChatMessageSelect;

/// Deliberately narrow. This is the only shape of another person that chat
/// ever exposes — no driver link, no active flag, no timestamps.
const participantSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
} satisfies Prisma.UserSelect;

export type ChatConversationRow = Prisma.ChatConversationGetPayload<{
  select: typeof conversationSelect;
}>;
export type ChatMemberRow = Prisma.ChatMemberGetPayload<{ select: typeof memberSelect }>;
export type ChatMessageRow = Prisma.ChatMessageGetPayload<{ select: typeof messageSelect }>;
export type ChatParticipantRow = Prisma.UserGetPayload<{ select: typeof participantSelect }>;

export type ChatMemberWithUser = Prisma.ChatMemberGetPayload<{
  select: typeof memberSelect & { user: { select: typeof participantSelect } };
}>;

/* ------------------------------------------------------------------ */
/* membership                                                          */
/* ------------------------------------------------------------------ */

/// Backs the route guard, so it returns the conversation too — the
/// controller then never re-queries what the guard already loaded.
export function findMembership(conversationId: string, userId: string) {
  return prisma.chatMember.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
    select: { ...memberSelect, conversation: { select: conversationSelect } },
  });
}

/// What the route guard attaches to the request. Derived from the query
/// rather than hand-written, so it cannot drift from what is actually loaded.
export type ChatMembershipContext = NonNullable<Awaited<ReturnType<typeof findMembership>>>;

export function listMembers(conversationId: string) {
  return prisma.chatMember.findMany({
    where: { conversationId },
    select: { ...memberSelect, user: { select: participantSelect } },
    orderBy: { joinedAt: 'asc' },
  });
}

/// One query for many conversations — used to label DIRECT threads with the
/// other person's name without an N+1.
export function listMembersForConversations(conversationIds: string[]) {
  return prisma.chatMember.findMany({
    where: { conversationId: { in: conversationIds } },
    select: { conversationId: true, userId: true, user: { select: participantSelect } },
  });
}

export function addMembers(conversationId: string, userIds: string[]) {
  return prisma.chatMember.createMany({
    // Re-adding someone already present is a no-op, not a 409.
    data: userIds.map((userId) => ({ conversationId, userId })),
    skipDuplicates: true,
  });
}

/// deleteMany, not delete: removing someone who is already gone should
/// succeed rather than raise P2025.
export function removeMember(conversationId: string, userId: string) {
  return prisma.chatMember.deleteMany({ where: { conversationId, userId } });
}

/// The OR clause is a monotonic clamp: an out-of-order request from a slow
/// tab can move the marker forward but never backwards.
export function markRead(conversationId: string, userId: string, at: Date) {
  return prisma.chatMember.updateMany({
    where: {
      conversationId,
      userId,
      OR: [{ lastReadAt: null }, { lastReadAt: { lt: at } }],
    },
    data: { lastReadAt: at },
  });
}

/* ------------------------------------------------------------------ */
/* participants                                                        */
/* ------------------------------------------------------------------ */

/**
 * Everyone an operator may start a conversation with — **drivers included**.
 *
 * Drivers are addressable but not callers: the router still gates every chat
 * endpoint at `requireMinRole('operator')`, so a driver token cannot reach any
 * of this. Widening the directory only means dispatch can message them.
 *
 * `role` rides along in `participantSelect`, so the console can label a driver
 * in the picker and keep them out of the add-to-space list, where the service
 * would reject them anyway.
 */
export function listDirectory(params: { excludeUserId: string; q?: string }) {
  return prisma.user.findMany({
    where: {
      active: true,
      id: { not: params.excludeUserId },
      ...(params.q
        ? {
            OR: [
              { name: { contains: params.q, mode: 'insensitive' as const } },
              { email: { contains: params.q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    },
    select: participantSelect,
    orderBy: { name: 'asc' },
  });
}

/**
 * Who may be put in a conversation.
 *
 * `allowDrivers` is the whole driver-messaging rule in one parameter, and it is
 * a parameter rather than a blanket widening on purpose:
 *
 * - **A direct message may include a driver** — that is dispatch talking to
 *   their courier, which is the point.
 * - **A space may not.** A driver dropped into a staff space would read
 *   everything said in it from the moment they joined, including the operator
 *   conversation about them. Dispatch↔driver is a DM relationship.
 *
 * Deactivated accounts never come back either way, and the service reports one
 * uniform error for every reason — so an id cannot be probed for its role.
 */
export function findEligibleParticipants(userIds: string[], allowDrivers = false) {
  return prisma.user.findMany({
    where: {
      id: { in: userIds },
      active: true,
      role: allowDrivers ? { in: ['driver', 'operator', 'admin'] } : { in: ['operator', 'admin'] },
    },
    select: participantSelect,
  });
}

/* ------------------------------------------------------------------ */
/* conversations                                                       */
/* ------------------------------------------------------------------ */

export function findConversationById(id: string) {
  return prisma.chatConversation.findUnique({ where: { id }, select: conversationSelect });
}

export function updateConversation(
  id: string,
  data: { name?: string; description?: string | null },
) {
  return prisma.chatConversation.update({ where: { id }, data, select: conversationSelect });
}

/**
 * The unique index on `directKey` is the real serializer here; the initial
 * read is only an optimisation. Two people pressing "message" on each other
 * at once means one of them loses the insert with P2002 and re-reads.
 */
export async function getOrCreateDirect(params: {
  directKey: string;
  createdById: string;
  memberIds: string[];
}) {
  const existing = await prisma.chatConversation.findUnique({
    where: { directKey: params.directKey },
    select: conversationSelect,
  });
  if (existing) return { row: existing, created: false };

  try {
    const row = await prisma.chatConversation.create({
      data: {
        type: 'DIRECT',
        directKey: params.directKey,
        createdById: params.createdById,
        members: { create: params.memberIds.map((userId) => ({ userId })) },
      },
      select: conversationSelect,
    });
    return { row, created: true };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const row = await prisma.chatConversation.findUniqueOrThrow({
        where: { directKey: params.directKey },
        select: conversationSelect,
      });
      return { row, created: false };
    }
    throw error;
  }
}

/// Creator and seed members land in the same transaction as the space, so a
/// half-failure can never leave a space nobody belongs to.
export function createSpace(params: {
  name: string;
  description?: string;
  createdById: string;
  memberIds: string[];
}) {
  const others = params.memberIds.filter((id) => id !== params.createdById);
  return prisma.chatConversation.create({
    data: {
      type: 'SPACE',
      name: params.name,
      description: params.description ?? null,
      createdById: params.createdById,
      members: {
        create: [
          { userId: params.createdById, role: 'OWNER' },
          ...others.map((userId) => ({ userId })),
        ],
      },
    },
    select: conversationSelect,
  });
}

export interface ChatListRow {
  id: string;
  type: string;
  name: string | null;
  description: string | null;
  directKey: string | null;
  lastMessageAt: Date | null;
  lastReadAt: Date | null;
  unreadCount: number;
  lastMessageId: string | null;
  lastMessageSenderId: string | null;
  lastMessageBody: string | null;
  lastMessageCreatedAt: Date | null;
}

/**
 * One query instead of 2N+1.
 *
 * Both the preview and the unread count vary per row (the `> lastReadAt`
 * threshold is different for every membership), so `groupBy` cannot express
 * it. Two LATERALs ride the (conversationId, createdAt, id) index; the driver
 * is the @@index([userId]) on chat_members.
 *
 * `count(*)` is bigint, which reaches JS as a BigInt that JSON.stringify
 * refuses to serialise — hence the ::int cast. The enum is cast to text for
 * the same reason: raw results skip Prisma's enum mapping.
 */
export function listConversationsForUser(userId: string) {
  return prisma.$queryRaw<ChatListRow[]>`
    SELECT c.id,
           c.type::text                       AS type,
           c.name,
           c.description,
           c."directKey",
           c."lastMessageAt",
           cm."lastReadAt",
           COALESCE(unread.n, 0)::int         AS "unreadCount",
           lm.id                              AS "lastMessageId",
           lm."senderId"                      AS "lastMessageSenderId",
           lm.body                            AS "lastMessageBody",
           lm."createdAt"                     AS "lastMessageCreatedAt"
    FROM chat_members cm
    JOIN chat_conversations c ON c.id = cm."conversationId"
    LEFT JOIN LATERAL (
      SELECT m.id, m."senderId", m.body, m."createdAt"
      FROM chat_messages m
      WHERE m."conversationId" = c.id AND m."deletedAt" IS NULL
      ORDER BY m."createdAt" DESC, m.id DESC
      LIMIT 1
    ) lm ON true
    LEFT JOIN LATERAL (
      SELECT count(*) AS n
      FROM chat_messages m
      WHERE m."conversationId" = c.id
        AND m."senderId" <> cm."userId"
        AND m."deletedAt" IS NULL
        AND m."createdAt" > COALESCE(cm."lastReadAt", '-infinity'::timestamp)
    ) unread ON true
    WHERE cm."userId" = ${userId}
    ORDER BY c."lastMessageAt" DESC NULLS LAST, c."createdAt" DESC
    LIMIT 200
  `;
}

/* ------------------------------------------------------------------ */
/* messages                                                            */
/* ------------------------------------------------------------------ */

/**
 * The one place `attachmentPath` is read. Returns the owning conversation too,
 * so the caller can check membership before minting a download link — the
 * message id alone must never be enough to reach a file.
 */
export function findAttachment(messageId: string) {
  return prisma.chatMessage.findUnique({
    where: { id: messageId },
    select: {
      id: true,
      conversationId: true,
      deletedAt: true,
      attachmentPath: true,
      attachmentName: true,
      attachmentMime: true,
      attachmentBytes: true,
      attachmentIsImage: true,
    },
  });
}

export function findMessageInConversation(conversationId: string, messageId: string) {
  return prisma.chatMessage.findFirst({
    where: { id: messageId, conversationId },
    select: { id: true, createdAt: true },
  });
}

/**
 * One clock for both writes. If `createdAt` came from the column default and
 * `lastMessageAt` from JS, the conversation list and the message cursor could
 * disagree about which message is newest.
 *
 * Message first, conversation second, on every path — the conversation row is
 * the hot lock and a fixed order keeps concurrent sends from deadlocking.
 *
 * The insert is what fires the broadcast trigger; see prisma/sql/chat.sql.
 */
export async function createMessage(params: {
  conversationId: string;
  senderId: string;
  body: string;
  clientMessageId: string;
  /** Already uploaded — see chat.storage.ts for why storage comes first. */
  attachment?: {
    path: string;
    name: string;
    mime: string;
    bytes: number;
    isImage: boolean;
  };
}) {
  const now = new Date();
  try {
    const [row] = await prisma.$transaction([
      prisma.chatMessage.create({
        data: {
          conversationId: params.conversationId,
          senderId: params.senderId,
          body: params.body,
          clientMessageId: params.clientMessageId,
          createdAt: now,
          attachmentPath: params.attachment?.path ?? null,
          attachmentName: params.attachment?.name ?? null,
          attachmentMime: params.attachment?.mime ?? null,
          attachmentBytes: params.attachment?.bytes ?? null,
          attachmentIsImage: params.attachment?.isImage ?? null,
        },
        select: messageSelect,
      }),
      prisma.chatConversation.update({
        where: { id: params.conversationId },
        data: { lastMessageAt: now },
      }),
    ]);
    return { row, created: true };
  } catch (error) {
    // A retry after a lost response returns the original message rather than
    // duplicating it — the normal case for a phone on a weak signal.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const row = await prisma.chatMessage.findFirstOrThrow({
        where: {
          conversationId: params.conversationId,
          clientMessageId: params.clientMessageId,
        },
        select: messageSelect,
      });
      return { row, created: false };
    }
    throw error;
  }
}

/**
 * Keyset pagination, not offset: messages are append-heavy, so an offset page
 * shifts under the reader. The `id` tiebreak is mandatory — createdAt is
 * timestamp(3), so two messages in one millisecond is entirely possible, and
 * cuid() is not reliably monotonic across processes.
 *
 * Prisma cannot express row-value comparison ((a,b) < (c,d)), hence the OR
 * form. Prisma's own `cursor` + `skip` is avoided deliberately: it requires
 * the cursor row to still exist, so one delete would break paging silently.
 *
 * Always newest-first. `take` is limit + 1 so the caller can detect more.
 */
export function listMessages(params: {
  conversationId: string;
  limit: number;
  before?: { createdAt: Date; id: string };
  after?: { createdAt: Date; id: string };
}) {
  const { conversationId, limit, before, after } = params;
  return prisma.chatMessage.findMany({
    where: {
      conversationId,
      deletedAt: null,
      ...(before
        ? {
            OR: [
              { createdAt: { lt: before.createdAt } },
              { createdAt: before.createdAt, id: { lt: before.id } },
            ],
          }
        : {}),
      ...(after
        ? {
            OR: [
              { createdAt: { gt: after.createdAt } },
              { createdAt: after.createdAt, id: { gt: after.id } },
            ],
          }
        : {}),
    },
    select: messageSelect,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });
}
