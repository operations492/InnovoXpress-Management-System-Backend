import type { Request, Response } from 'express';
import * as authService from './auth.service.js';
import { AppError } from '../../utils/httpError.js';

export async function me(req: Request, res: Response) {
  if (!req.user) throw AppError.unauthorized();
  const user = await authService.me(req.user.id);
  res.status(200).json({ user });
}
