import type { Request } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { getValidatedQuery } from '../../middleware/validate.js';
import type { ListZonesQuery } from '../../schemas/zone.schema.js';
import * as service from './zones.service.js';

/** Retired zones are wanted by the admin screen and by nothing else. */
const wantsInactive = (req: Request) =>
  getValidatedQuery<ListZonesQuery>(req).includeInactive === 'true';

export const list = asyncHandler(async (req, res) => {
  res.status(200).json(await service.listZoneLists(wantsInactive(req)));
});

export const get = asyncHandler(async (req, res) => {
  res.status(200).json(await service.getZoneList(req.params.id as string, wantsInactive(req)));
});

export const create = asyncHandler(async (req, res) => {
  res.status(201).json(await service.createZoneList(req.body));
});

export const update = asyncHandler(async (req, res) => {
  res.status(200).json(await service.updateZoneList(req.params.id as string, req.body));
});

export const remove = asyncHandler(async (req, res) => {
  await service.deleteZoneList(req.params.id as string);
  res.status(204).end();
});

/* ------------------------------------------------------------------ zones */

export const getZone = asyncHandler(async (req, res) => {
  res
    .status(200)
    .json(await service.getZone(req.params.id as string, req.params.zoneId as string));
});

export const createZone = asyncHandler(async (req, res) => {
  res.status(201).json(await service.createZone(req.params.id as string, req.body));
});

export const updateZone = asyncHandler(async (req, res) => {
  res
    .status(200)
    .json(
      await service.updateZone(req.params.id as string, req.params.zoneId as string, req.body),
    );
});

export const removeZone = asyncHandler(async (req, res) => {
  // A zone named on a priced route is deactivated rather than deleted, so the
  // response says which happened instead of returning a bare 204.
  res
    .status(200)
    .json(await service.deleteZone(req.params.id as string, req.params.zoneId as string));
});

/* ------------------------------------------------------------------ codes */

export const previewCodes = asyncHandler(async (req, res) => {
  res
    .status(200)
    .json(
      await service.previewCodes(
        req.params.id as string,
        req.params.zoneId as string,
        req.body.text,
      ),
    );
});

export const saveCodes = asyncHandler(async (req, res) => {
  res
    .status(200)
    .json(
      await service.saveCodes(req.params.id as string, req.params.zoneId as string, req.body.text),
    );
});

/* -------------------------------------------------------------- the map */

export const previewShape = asyncHandler(async (req, res) => {
  res
    .status(200)
    .json(
      await service.previewShape(
        req.params.id as string,
        req.params.zoneId as string,
        req.body.geojson,
      ),
    );
});

export const saveShape = asyncHandler(async (req, res) => {
  res
    .status(200)
    .json(
      await service.saveShape(
        req.params.id as string,
        req.params.zoneId as string,
        req.body.geojson,
        req.body.codes,
      ),
    );
});

export const removeShape = asyncHandler(async (req, res) => {
  await service.removeShape(req.params.id as string, req.params.zoneId as string);
  res.status(204).end();
});

export const removeCode = asyncHandler(async (req, res) => {
  await service.removeCode(
    req.params.id as string,
    req.params.zoneId as string,
    req.params.code as string,
  );
  res.status(204).end();
});
