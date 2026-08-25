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
 * Chat reaches drivers now, so the router-level gate drops to `driver` and the
 * staff-only rules move to the two routes that actually need them.
 *
 * What holds this together is that **every `/:id` route below is guarded by
 * `requireConversationMember`, which tests membership rather than role.** A
 * driver therefore reaches exactly the threads they were put in, and no more —
 * the same guard that already stopped an operator reading a DM they were not
 * part of. Opening the router did not weaken it.
 *
 * Two things stay staff-only, immediately below: creating a space, and adding
 * members to one.
 */
router.use(authenticate, requireMinRole('driver'));

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
/*
 * Spaces are staff-only, both to create and to join.
 *
 * A driver dropped into a staff space reads everything said in it from the
 * moment they join — including the operators' conversation about them.
 * Dispatch↔driver is a DM relationship, and `assertEligible` enforces the same
 * rule a second time in the service.
 */
router.post(
  '/conversations/spaces',
  requireMinRole('operator'),
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
  requireMinRole('operator'),
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
