import type { Request, Response } from 'express';
import * as authService from './auth.service.js';
import { AppError } from '../../utils/httpError.js';
import type { PushTokenBody } from '../../schemas/push.schema.js';

export async function me(req: Request, res: Response) {
  if (!req.user) throw AppError.unauthorized();
  const user = await authService.me(req.user.id);
  res.status(200).json({ user });
}

export async function setPushToken(req: Request, res: Response) {
  if (!req.user) throw AppError.unauthorized();
  const { pushToken } = req.body as PushTokenBody;
  await authService.setPushToken(req.user.id, pushToken);
  res.status(204).send();
}
