import { z } from 'zod';

/*
 * Every object is .strict(): an unknown key is a 400, not a silent drop.
 * That is what stops `senderId`, `createdAt` or a conversation `type` being
 * smuggled into a request — those are server-owned.
 */

/* ------------------------------------------------------------------ */
/* params                                                              */
/* ------------------------------------------------------------------ */

export const conversationIdParamSchema = z
  .object({
    id: z.string().min(1),
  })
  .strict();

export const memberParamsSchema = z
  .object({
    id: z.string().min(1),
    userId: z.string().min(1),
  })
  .strict();

/* ------------------------------------------------------------------ */
/* directory                                                           */
/* ------------------------------------------------------------------ */

export const directoryQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

/* ------------------------------------------------------------------ */
/* conversations                                                       */
/* ------------------------------------------------------------------ */

export const createDirectSchema = z
  .object({
    userId: z.string().min(1),
  })
  .strict();

export const createSpaceSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).optional(),
    /// Seed members. The creator is added as OWNER in the same transaction,
    /// so a failure can never leave an empty space behind.
    userIds: z.array(z.string().min(1)).max(50).optional(),
  })
  .strict();

export const updateSpaceSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(500).nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, {
    message: 'Provide at least one field to update',
  });

export const addMembersSchema = z
  .object({
    userIds: z.array(z.string().min(1)).min(1).max(50),
  })
  .strict();

/* ------------------------------------------------------------------ */
/* messages                                                            */
/* ------------------------------------------------------------------ */

export const sendMessageSchema = z
  .object({
    body: z.string().trim().min(1).max(4000),
    /// Client-generated. Required, not optional: a retry after a lost
    /// response must return the original message rather than duplicate it,
    /// and the client needs it to dedupe its own optimistic bubble against
    /// the broadcast echo.
    clientMessageId: z.uuid(),
  })
  .strict();

/**
 * The multipart sibling of sendMessageSchema. Multipart text fields always
 * arrive as strings, and the caption is optional because a file on its own is
 * a perfectly good message — a CHECK constraint enforces that a message must
 * carry text, a file, or both.
 */
export const sendAttachmentSchema = z
  .object({
    body: z.string().trim().max(4000).optional(),
    clientMessageId: z.uuid(),
  })
  .strict();

export const attachmentParamsSchema = z
  .object({
    id: z.string().min(1),
    messageId: z.string().min(1),
  })
  .strict();

export const listMessagesQuerySchema = z
  .object({
    /// Opaque keyset cursors. `before` pages backwards through history;
    /// `after` fetches everything newer, which is how a client reconciles
    /// after a dropped connection — broadcast is best-effort.
    before: z.string().max(200).optional(),
    after: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict()
  .refine((v) => !(v.before && v.after), {
    message: 'Use before or after, not both',
  });

export const markReadSchema = z
  .object({
    /// The last message the user actually rendered — never an implicit
    /// "now", which would mark messages they have not seen.
    lastMessageId: z.string().min(1),
  })
  .strict();

/* ------------------------------------------------------------------ */
/* inferred types                                                      */
/* ------------------------------------------------------------------ */

export type DirectoryQuery = z.infer<typeof directoryQuerySchema>;
export type CreateDirectInput = z.infer<typeof createDirectSchema>;
export type CreateSpaceInput = z.infer<typeof createSpaceSchema>;
export type UpdateSpaceInput = z.infer<typeof updateSpaceSchema>;
export type AddMembersInput = z.infer<typeof addMembersSchema>;
export type SendMessageInput = z.infer<typeof sendMessageSchema>;
export type SendAttachmentInput = z.infer<typeof sendAttachmentSchema>;
export type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>;
export type MarkReadInput = z.infer<typeof markReadSchema>;
