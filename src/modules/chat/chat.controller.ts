import type { Request, Response } from 'express';
import * as service from './chat.service.js';
import { AppError } from '../../utils/httpError.js';
import { getValidatedQuery } from '../../middleware/validate.js';
import type { DirectoryQuery, ListMessagesQuery } from '../../schemas/chat.schema.js';

/* HTTP in, plain arguments out. No business rules live here. */

function viewerId(req: Request): string {
  const user = req.user;
  if (!user) throw AppError.unauthorized();
  return user.id;
}

/**
 * The caller's role, for the two places chat cares about it.
 *
 * Read from `req.user` — our profile row — never from the token's own `role`
 * claim, which is always `authenticated` and is the Postgres role for RLS.
 */
function viewerRole(req: Request): string {
  const user = req.user;
  if (!user) throw AppError.unauthorized();
  return user.role;
}

/// The guard already loaded and authorized this; re-reading it from the
/// request avoids a second query per call.
function conversation(req: Request) {
  const membership = req.chatMembership;
  if (!membership) throw AppError.forbidden('You are not a member of this conversation');
  return membership.conversation;
}

/* ------------------------------------------------------------------ */
/* participants                                                        */
/* ------------------------------------------------------------------ */

export async function directory(req: Request, res: Response) {
  const query = getValidatedQuery<DirectoryQuery>(req);
  res.status(200).json(await service.listDirectory(viewerId(req), viewerRole(req), query));
}

/* ------------------------------------------------------------------ */
/* conversations                                                       */
/* ------------------------------------------------------------------ */

export async function listConversations(req: Request, res: Response) {
  res.status(200).json(await service.listConversations(viewerId(req)));
}

export async function openDirect(req: Request, res: Response) {
  const { conversation: row, created } = await service.openDirect(
    viewerId(req),
    viewerRole(req),
    req.body,
  );
  // 201 when we minted it, 200 when it already existed — the endpoint is
  // idempotent, so "message this person" is safe to press twice.
  res.status(created ? 201 : 200).json(row);
}

export async function createSpace(req: Request, res: Response) {
  res.status(201).json(await service.createSpace(viewerId(req), req.body));
}

export async function getConversation(req: Request, res: Response) {
  res.status(200).json(await service.getConversation(viewerId(req), conversation(req)));
}

export async function updateSpace(req: Request, res: Response) {
  res.status(200).json(await service.updateSpace(viewerId(req), conversation(req), req.body));
}

/* ------------------------------------------------------------------ */
/* members                                                             */
/* ------------------------------------------------------------------ */

export async function addMembers(req: Request, res: Response) {
  res.status(200).json(await service.addMembers(viewerId(req), conversation(req), req.body));
}

export async function removeMember(req: Request, res: Response) {
  const { userId } = req.params as unknown as { userId: string };
  res.status(200).json(await service.removeMember(viewerId(req), conversation(req), userId));
}

export async function leave(req: Request, res: Response) {
  res.status(200).json(await service.leave(viewerId(req), conversation(req)));
}

/* ------------------------------------------------------------------ */
/* messages                                                            */
/* ------------------------------------------------------------------ */

export async function listMessages(req: Request, res: Response) {
  const query = getValidatedQuery<ListMessagesQuery>(req);
  res.status(200).json(await service.listMessages(conversation(req).id, query));
}

export async function sendMessage(req: Request, res: Response) {
  const { message, created } = await service.sendMessage(
    viewerId(req),
    conversation(req).id,
    req.body,
  );
  // 200 on an idempotent replay of the same clientMessageId.
  res.status(created ? 201 : 200).json(message);
}

export async function sendAttachment(req: Request, res: Response) {
  const file = req.file;
  if (!file) throw AppError.badRequest('Attach a file in the "file" field');

  const { message, created } = await service.sendAttachment(
    viewerId(req),
    conversation(req).id,
    req.body,
    file,
  );
  res.status(created ? 201 : 200).json(message);
}

export async function getAttachment(req: Request, res: Response) {
  const { messageId } = req.params as unknown as { messageId: string };
  res.status(200).json(await service.getAttachment(conversation(req).id, messageId));
}

export async function markRead(req: Request, res: Response) {
  res.status(200).json(await service.markRead(viewerId(req), conversation(req).id, req.body));
}
