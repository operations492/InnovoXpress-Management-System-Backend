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

export async function setAvatar(req: Request, res: Response) {
  if (!req.user) throw AppError.unauthorized();

  /*
   * Absent for two different reasons, and the message has to cover both: no file
   * was sent at all, or multer's fileFilter rejected the declared type and
   * dropped it silently. A bare "photo is required" would be actively
   * misleading for the second, which is the one a driver actually hits when the
   * picker hands over a HEIC.
   */
  if (!req.file) {
    throw AppError.badRequest(
      'Attach one image on the `photo` field. JPEG, PNG and WebP are accepted.',
    );
  }

  const result = await authService.setAvatar(req.user.id, req.file);
  res.status(200).json(result);
}

export async function removeAvatar(req: Request, res: Response) {
  if (!req.user) throw AppError.unauthorized();
  await authService.removeAvatar(req.user.id);
  res.status(204).send();
}
