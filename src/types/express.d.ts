import type { AuthUser } from './auth.js';
import type { ChatMembershipContext } from '../modules/chat/chat.repository.js';

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      /// Set by requireConversationMember. Present only on chat routes that
      /// are scoped to a single conversation.
      chatMembership?: ChatMembershipContext;
    }
  }
}

export {};
