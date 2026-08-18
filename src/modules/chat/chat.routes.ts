import { Router } from 'express';
import * as controller from './chat.controller.js';
import { authenticate } from '../../middleware/auth.js';
import { requireMinRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { requireConversationMember } from './chat.guard.js';
import { limitSendRate } from './chat.rateLimit.js';
import { uploadChatFile } from './chat.upload.js';
import {
  addMembersSchema,
  attachmentParamsSchema,
  sendAttachmentSchema,
  conversationIdParamSchema,
  createDirectSchema,
  createSpaceSchema,
  directoryQuerySchema,
  listMessagesQuerySchema,
  markReadSchema,
  memberParamsSchema,
  sendMessageSchema,
  updateSpaceSchema,
} from '../../schemas/chat.schema.js';

const router = Router();

/*
 * Chat is staff-only. `requireMinRole('operator')` means a driver token fails
 * every route here by construction, which is the first of two gates — the
 * broadcast fan-out in prisma/sql/chat.sql applies the same exclusion so a
 * demoted operator stops receiving messages too.
 */
router.use(authenticate, requireMinRole('operator'));

router.get(
  '/directory',
  validate(directoryQuerySchema, 'query'),
  asyncHandler(controller.directory),
);

router.get('/conversations', asyncHandler(controller.listConversations));

// Before /conversations/:id, or "direct" and "spaces" are read as ids.
router.post(
  '/conversations/direct',
  validate(createDirectSchema),
  asyncHandler(controller.openDirect),
);
router.post(
  '/conversations/spaces',
  validate(createSpaceSchema),
  asyncHandler(controller.createSpace),
);

/*
 * Every route below is resource-scoped. `requireConversationMember` runs on
 * all of them — including POST messages, which is the easy one to forget and
 * the worst one to miss.
 */
router.get(
  '/conversations/:id',
  validate(conversationIdParamSchema, 'params'),
  requireConversationMember,
  asyncHandler(controller.getConversation),
);

router.patch(
  '/conversations/:id',
  validate(conversationIdParamSchema, 'params'),
  validate(updateSpaceSchema),
  requireConversationMember,
  asyncHandler(controller.updateSpace),
);

router.get(
  '/conversations/:id/messages',
  validate(conversationIdParamSchema, 'params'),
  validate(listMessagesQuerySchema, 'query'),
  requireConversationMember,
  asyncHandler(controller.listMessages),
);

router.post(
  '/conversations/:id/messages',
  validate(conversationIdParamSchema, 'params'),
  validate(sendMessageSchema),
  requireConversationMember,
  limitSendRate,
  asyncHandler(controller.sendMessage),
);

/*
 * File sharing. Multer runs FIRST — multipart text fields do not exist on
 * req.body until it has parsed the request, so validation cannot precede it.
 *
 * Access needs no new mechanism: requireConversationMember already means a
 * space's members see its files and a direct message stays between its two
 * people.
 */
router.post(
  '/conversations/:id/attachments',
  validate(conversationIdParamSchema, 'params'),
  uploadChatFile,
  validate(sendAttachmentSchema),
  requireConversationMember,
  limitSendRate,
  asyncHandler(controller.sendAttachment),
);

router.get(
  '/conversations/:id/messages/:messageId/attachment',
  validate(attachmentParamsSchema, 'params'),
  requireConversationMember,
  asyncHandler(controller.getAttachment),
);

router.post(
  '/conversations/:id/members',
  validate(conversationIdParamSchema, 'params'),
  validate(addMembersSchema),
  requireConversationMember,
  asyncHandler(controller.addMembers),
);

router.delete(
  '/conversations/:id/members/:userId',
  validate(memberParamsSchema, 'params'),
  requireConversationMember,
  asyncHandler(controller.removeMember),
);

router.post(
  '/conversations/:id/leave',
  validate(conversationIdParamSchema, 'params'),
  requireConversationMember,
  asyncHandler(controller.leave),
);

router.post(
  '/conversations/:id/read',
  validate(conversationIdParamSchema, 'params'),
  validate(markReadSchema),
  requireConversationMember,
  asyncHandler(controller.markRead),
);

export default router;
