import { AppError } from '../../utils/httpError.js';
import * as repo from './chat.repository.js';
import * as storage from './chat.storage.js';
import type {
  AddMembersInput,
  CreateDirectInput,
  CreateSpaceInput,
  DirectoryQuery,
  ListMessagesQuery,
  MarkReadInput,
  SendAttachmentInput,
  SendMessageInput,
  UpdateSpaceInput,
} from '../../schemas/chat.schema.js';

/*
 * Business rules for chat. Never imports prisma — see chat.repository.ts.
 *
 * One rule is worth stating up front: whenever a participant is rejected,
 * the reason is never disclosed. "No such user", "deactivated" and "that is
 * a driver" all return the same 404, so an id cannot be probed for its role.
 */

const UNKNOWN_PARTICIPANT = 'User not found';

/* ------------------------------------------------------------------ */
/* dto                                                                 */
/* ------------------------------------------------------------------ */

function toParticipantDto(user: repo.ChatParticipantRow) {
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}

/**
 * MUST stay structurally identical to the broadcast payload built in
 * prisma/sql/chat.sql — the client parses both with one function. `createdAt`
 * is a Date here, which res.json renders as an ISO-8601 string with
 * milliseconds and a Z, matching the trigger's to_char mask exactly.
 * tests/chatRealtime.test.ts asserts the two are equal.
 */
function toMessageDto(message: repo.ChatMessageRow) {
  // A CHECK constraint guarantees these five columns are all set or all null,
  // but narrowing them explicitly keeps the DTO honest without assertions.
  const attachment =
    message.attachmentName !== null &&
    message.attachmentMime !== null &&
    message.attachmentBytes !== null &&
    message.attachmentIsImage !== null
      ? {
          name: message.attachmentName,
          mime: message.attachmentMime,
          bytes: message.attachmentBytes,
          isImage: message.attachmentIsImage,
        }
      : null;

  return {
    id: message.id,
    conversationId: message.conversationId,
    senderId: message.senderId,
    type: message.type,
    body: message.body,
    clientMessageId: message.clientMessageId,
    createdAt: message.createdAt,
    // No URL here on purpose: a signed link expires, and this shape has to
    // stay byte-identical to the broadcast payload.
    attachment,
  };
}

function toMemberDto(member: repo.ChatMemberWithUser) {
  return {
    userId: member.userId,
    role: member.role,
    joinedAt: member.joinedAt,
    user: toParticipantDto(member.user),
  };
}

/// A DIRECT conversation stores no name — it is labelled with whoever the
/// viewer is talking to, which differs per viewer.
function labelFor(
  type: string,
  storedName: string | null,
  counterpart: repo.ChatParticipantRow | null,
): string {
  if (type !== 'DIRECT') return storedName ?? 'Untitled space';
  return counterpart?.name ?? 'Unknown user';
}

function toConversationDto(
  row: repo.ChatConversationRow,
  members: repo.ChatMemberWithUser[],
  viewerId: string,
) {
  const counterpart =
    row.type === 'DIRECT' ? (members.find((m) => m.userId !== viewerId)?.user ?? null) : null;

  return {
    id: row.id,
    type: row.type,
    name: labelFor(row.type, row.name, counterpart),
    description: row.description,
    counterpart: counterpart ? toParticipantDto(counterpart) : null,
    memberCount: members.length,
    members: members.map(toMemberDto),
    createdById: row.createdById,
    lastMessageAt: row.lastMessageAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function withMembers(row: repo.ChatConversationRow, viewerId: string) {
  const members = await repo.listMembers(row.id);
  return toConversationDto(row, members, viewerId);
}

/* ------------------------------------------------------------------ */
/* cursors                                                             */
/* ------------------------------------------------------------------ */

function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`, 'utf8').toString('base64url');
}

/// Opaque to the client and never passed to Prisma unvalidated.
function decodeCursor(raw: string): { createdAt: Date; id: string } {
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  const separator = decoded.lastIndexOf('|');
  if (separator <= 0) throw AppError.badRequest('Invalid cursor');

  const createdAt = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  if (Number.isNaN(createdAt.getTime()) || !id) throw AppError.badRequest('Invalid cursor');

  return { createdAt, id };
}

/* ------------------------------------------------------------------ */
/* participants                                                        */
/* ------------------------------------------------------------------ */

export async function listDirectory(viewerId: string, query: DirectoryQuery) {
  const rows = await repo.listDirectory({ excludeUserId: viewerId, q: query.q });
  return { data: rows.map(toParticipantDto) };
}

/// Throws the uniform error unless every requested id is a real, active,
/// non-driver account.
async function assertEligible(userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  const eligible = await repo.findEligibleParticipants(userIds);
  if (eligible.length !== userIds.length) throw AppError.notFound(UNKNOWN_PARTICIPANT);
}

/* ------------------------------------------------------------------ */
/* conversations                                                       */
/* ------------------------------------------------------------------ */

export async function listConversations(viewerId: string) {
  const rows = await repo.listConversationsForUser(viewerId);
  if (rows.length === 0) return { data: [], meta: { totalUnread: 0 } };

  // One extra query for every conversation at once, rather than one per row.
  const members = await repo.listMembersForConversations(rows.map((r) => r.id));
  const byConversation = new Map<string, typeof members>();
  for (const member of members) {
    const bucket = byConversation.get(member.conversationId);
    if (bucket) bucket.push(member);
    else byConversation.set(member.conversationId, [member]);
  }

  const data = rows.map((row) => {
    const conversationMembers = byConversation.get(row.id) ?? [];
    const counterpart =
      row.type === 'DIRECT'
        ? (conversationMembers.find((m) => m.userId !== viewerId)?.user ?? null)
        : null;

    return {
      id: row.id,
      type: row.type,
      name: labelFor(row.type, row.name, counterpart),
      description: row.description,
      counterpart: counterpart ? toParticipantDto(counterpart) : null,
      memberCount: conversationMembers.length,
      unreadCount: row.unreadCount,
      lastReadAt: row.lastReadAt,
      lastMessageAt: row.lastMessageAt,
      lastMessage: row.lastMessageId
        ? {
            id: row.lastMessageId,
            senderId: row.lastMessageSenderId,
            body: row.lastMessageBody,
            createdAt: row.lastMessageCreatedAt,
          }
        : null,
    };
  });

  // Returned here so the nav badge needs no second request.
  const totalUnread = data.reduce((sum, row) => sum + row.unreadCount, 0);
  return { data, meta: { totalUnread } };
}

export async function openDirect(viewerId: string, input: CreateDirectInput) {
  if (input.userId === viewerId) {
    throw AppError.badRequest('You cannot start a direct message with yourself');
  }
  await assertEligible([input.userId]);

  // Sorted in JS, never in SQL: a database sort would be collation-dependent
  // and could produce two different keys for one pair across environments.
  // Lowercased for the key only — the member rows keep the real ids.
  const directKey = [viewerId, input.userId]
    .map((id) => id.toLowerCase())
    .sort()
    .join(':');

  const { row, created } = await repo.getOrCreateDirect({
    directKey,
    createdById: viewerId,
    memberIds: [viewerId, input.userId],
  });

  return { conversation: await withMembers(row, viewerId), created };
}

export async function createSpace(viewerId: string, input: CreateSpaceInput) {
  const invited = [...new Set(input.userIds ?? [])].filter((id) => id !== viewerId);
  await assertEligible(invited);

  const row = await repo.createSpace({
    name: input.name,
    description: input.description,
    createdById: viewerId,
    memberIds: invited,
  });

  return withMembers(row, viewerId);
}

export async function getConversation(viewerId: string, row: repo.ChatConversationRow) {
  return withMembers(row, viewerId);
}

export async function updateSpace(
  viewerId: string,
  conversation: repo.ChatConversationRow,
  input: UpdateSpaceInput,
) {
  if (conversation.type === 'DIRECT') {
    throw AppError.conflict('A direct message cannot be renamed');
  }

  const row = await repo.updateConversation(conversation.id, {
    name: input.name,
    description: input.description,
  });
  return withMembers(row, viewerId);
}

/* ------------------------------------------------------------------ */
/* members                                                             */
/* ------------------------------------------------------------------ */

export async function addMembers(
  viewerId: string,
  conversation: repo.ChatConversationRow,
  input: AddMembersInput,
) {
  // No CHECK constraint can express "a DIRECT conversation has exactly two
  // members", so it is enforced here. Without it a DM silently becomes a
  // group chat that still renders as a DM.
  if (conversation.type === 'DIRECT') {
    throw AppError.conflict('A direct message cannot take extra members');
  }

  const requested = [...new Set(input.userIds)];
  await assertEligible(requested);
  await repo.addMembers(conversation.id, requested);

  return withMembers(conversation, viewerId);
}

export async function removeMember(
  viewerId: string,
  conversation: repo.ChatConversationRow,
  targetUserId: string,
) {
  if (conversation.type === 'DIRECT') {
    throw AppError.conflict('A direct message cannot lose members');
  }

  await repo.removeMember(conversation.id, targetUserId);
  return withMembers(conversation, viewerId);
}

/// Distinct from removeMember on purpose: "I left" and "you were removed"
/// will need different permission rules and different system messages, and
/// separating them now costs nothing.
export async function leave(viewerId: string, conversation: repo.ChatConversationRow) {
  if (conversation.type === 'DIRECT') {
    throw AppError.conflict('You cannot leave a direct message');
  }

  await repo.removeMember(conversation.id, viewerId);
  // An emptied space is left in place rather than cascaded away; it is
  // history, and nothing in v1 needs to reclaim it.
  return { left: true };
}

/* ------------------------------------------------------------------ */
/* messages                                                            */
/* ------------------------------------------------------------------ */

export async function listMessages(conversationId: string, query: ListMessagesQuery) {
  const before = query.before ? decodeCursor(query.before) : undefined;
  const after = query.after ? decodeCursor(query.after) : undefined;

  const rows = await repo.listMessages({
    conversationId,
    limit: query.limit,
    before,
    after,
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const oldest = page[page.length - 1];

  return {
    data: page.map(toMessageDto),
    meta: {
      hasMore,
      // Pages backwards through history. Newest-first throughout, so the
      // client reverses for display.
      nextCursor: hasMore && oldest ? encodeCursor(oldest) : null,
    },
  };
}

export async function sendMessage(
  viewerId: string,
  conversationId: string,
  input: SendMessageInput,
) {
  const { row, created } = await repo.createMessage({
    conversationId,
    senderId: viewerId,
    body: input.body,
    clientMessageId: input.clientMessageId,
  });

  return { message: toMessageDto(row), created };
}

/**
 * Send a file, optionally with a caption.
 *
 * Storage first, then the row — the same ordering proof-of-delivery uses. The
 * reverse would allow a message pointing at a file that was never written,
 * which is the one failure this feature must not have. Every path that does
 * not end in a stored message deletes the object it just uploaded.
 */
export async function sendAttachment(
  viewerId: string,
  conversationId: string,
  input: SendAttachmentInput,
  file: { buffer: Buffer; originalname?: string; mimetype?: string; size: number },
) {
  const stored = await storage.uploadAttachment({ conversationId, file });

  try {
    const { row, created } = await repo.createMessage({
      conversationId,
      senderId: viewerId,
      body: input.body?.trim() ?? '',
      clientMessageId: input.clientMessageId,
      attachment: stored,
    });

    // An idempotent replay keeps the ORIGINAL message and its original file;
    // the copy we just uploaded is an orphan.
    if (!created) await storage.removeAttachment(stored.path);

    return { message: toMessageDto(row), created };
  } catch (error) {
    await storage.removeAttachment(stored.path);
    throw error;
  }
}

/**
 * Mint a short-lived download link.
 *
 * The conversation is checked as well as the message, so a message id from
 * another thread cannot be used to reach a file — membership is verified by
 * the route guard on `:id`, and this makes the message genuinely belong to it.
 */
export async function getAttachment(conversationId: string, messageId: string) {
  const row = await repo.findAttachment(messageId);

  // One response for "no such message", "deleted", "no file" and "belongs to
  // another conversation" — the id must not reveal which.
  if (
    !row ||
    row.deletedAt !== null ||
    row.conversationId !== conversationId ||
    row.attachmentPath === null ||
    row.attachmentName === null ||
    row.attachmentIsImage === null
  ) {
    throw AppError.notFound('Attachment not found');
  }

  const links = await storage.signAttachment({
    path: row.attachmentPath,
    name: row.attachmentName,
    isImage: row.attachmentIsImage,
  });

  return {
    messageId: row.id,
    name: row.attachmentName,
    mime: row.attachmentMime,
    bytes: row.attachmentBytes,
    isImage: row.attachmentIsImage,
    ...links,
  };
}

export async function markRead(viewerId: string, conversationId: string, input: MarkReadInput) {
  // Resolved from a message the client actually rendered rather than an
  // implicit now(), which would mark messages it has never shown.
  const message = await repo.findMessageInConversation(conversationId, input.lastMessageId);
  if (!message) throw AppError.notFound('Message not found');

  await repo.markRead(conversationId, viewerId, message.createdAt);
  return { lastReadAt: message.createdAt };
}
