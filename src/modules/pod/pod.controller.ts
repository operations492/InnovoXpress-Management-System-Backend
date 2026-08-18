import type { Request } from 'express';
import type { PodLeg } from '@prisma/client';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { AppError } from '../../utils/httpError.js';
import * as service from './pod.service.js';

function actorOf(req: Request): service.Actor {
  if (!req.user) throw AppError.unauthorized();
  return { id: req.user.id, email: req.user.email };
}

/** Params are validated (and `leg` uppercased to the enum) before a handler runs. */
function paramsOf(req: Request) {
  return req.params as unknown as { id: string; leg: PodLeg };
}

function filesOf(req: Request) {
  const files = req.files as Record<string, Express.Multer.File[]> | undefined;
  const pick = (field: string) => {
    const f = files?.[field]?.[0];
    return f ? { buffer: f.buffer, size: f.size } : undefined;
  };
  return { photo: pick('photo'), signature: pick('signature') };
}

export const capture = asyncHandler(async (req, res) => {
  const { id, leg } = paramsOf(req);
  const idempotencyKey = req.get('Idempotency-Key') ?? undefined;

  const { proof, replayed } = await service.captureProof(
    id,
    leg,
    filesOf(req),
    req.body,
    actorOf(req),
    idempotencyKey,
  );

  // 200 on a replayed retry, 201 on a genuine capture.
  res.status(replayed ? 200 : 201).json({ proof });
});

export const list = asyncHandler(async (req, res) => {
  const id = (req.params as unknown as { id: string }).id;
  res.status(200).json({ proof: await service.getProofs(id) });
});

export const replace = asyncHandler(async (req, res) => {
  const { id, leg } = paramsOf(req);
  const proof = await service.replaceProofFiles(id, leg, filesOf(req), actorOf(req));
  res.status(200).json({ proof });
});
