import type { Request, Response } from 'express';
import { PodLeg } from '@prisma/client';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { AppError } from '../../utils/httpError.js';
import { KIND_SLUGS } from '../../schemas/orderDoc.schema.js';
import type { DocFlagsInput, DocListQuery } from '../../schemas/orderDoc.schema.js';
import * as service from './orderDocs.service.js';

/**
 * Express 5 types every path param as `string | string[]`. The routes validate
 * these with the schemas in `orderDoc.schema.ts` first, so by the time a handler
 * runs they are single validated strings from a known set.
 */
function paramsOf(req: Request) {
  return req.params as unknown as { id: string; kind: string; leg?: string };
}

function kindOf(req: Request) {
  const { kind } = paramsOf(req);
  // The schema already restricted it to the slug set; this is the lookup, not a
  // second check. A miss would be a programming error, not a bad request.
  return KIND_SLUGS[kind]!;
}

function legOf(req: Request): PodLeg {
  return paramsOf(req).leg === 'pickup' ? PodLeg.PICKUP : PodLeg.DELIVERY;
}

/**
 * Who is signing. A driver signing their own stop is the normal case; an
 * operator signing on the phone's behalf happens when paperwork is faxed back to
 * the office, so both ids are recorded and either may be null.
 */
function actorOf(req: Request) {
  if (!req.user) throw AppError.unauthorized();
  return { userId: req.user.id, driverId: req.user.driverId ?? null };
}

function send(res: Response, body: unknown) {
  res.status(200).json(body);
}

export const list = asyncHandler(async (req, res) => {
  const { leg } = req.query as unknown as DocListQuery;
  send(res, await service.list(paramsOf(req).id, leg));
});

export const put = asyncHandler(async (req, res) => {
  const actor = actorOf(req);
  send(res, await service.put(paramsOf(req).id, kindOf(req), req.file, actor.userId));
});

export const setFlags = asyncHandler(async (req, res) => {
  send(res, await service.setFlags(paramsOf(req).id, kindOf(req), req.body as DocFlagsInput));
});

export const remove = asyncHandler(async (req, res) => {
  send(res, await service.remove(paramsOf(req).id, kindOf(req)));
});

export const sign = asyncHandler(async (req, res) => {
  send(
    res,
    await service.sign(paramsOf(req).id, kindOf(req), legOf(req), req.file, actorOf(req)),
  );
});

/* ------------------------------------------------ release letter (deprecated) */

export const releaseLetter = asyncHandler(async (req, res) => {
  send(res, await service.releaseLetterCompat(paramsOf(req).id));
});

export const putReleaseLetter = asyncHandler(async (req, res) => {
  send(res, await service.putReleaseLetterCompat(paramsOf(req).id, req.file, actorOf(req).userId));
});

export const removeReleaseLetter = asyncHandler(async (req, res) => {
  send(res, await service.removeReleaseLetterCompat(paramsOf(req).id));
});
