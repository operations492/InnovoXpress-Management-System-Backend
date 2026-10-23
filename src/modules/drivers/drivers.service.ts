import type { Prisma } from '@prisma/client';
import type { DriversQuery } from '../../schemas/assignment.schema.js';
import * as repo from './drivers.repository.js';
import { AppError } from '../../utils/httpError.js';
import { sniffImage } from '../../utils/imageSniff.js';
import {
  objectPath,
  removeObjects,
  signedUrl,
  uploadObject,
  type DriverDocKind,
} from '../../utils/driverDocs.js';
// Colour assignment lives in map.service, the same dependency users.service has.
import { nextColorIndex } from '../map/map.service.js';
import type { CreateDriverInput, UpdateDriverInput } from '../../schemas/driver.schema.js';

/**
 * The dispatcher's driver panel.
 *
 * `activeLoad` is every job still on the driver's plate — anything not yet
 * DELIVERED. It is what tells a dispatcher who is free before they allocate.
 */
export async function listDrivers(query: DriversQuery) {
  const where: Prisma.DriverWhereInput = {};

  if (query.includeInactive !== 'true') where.active = true;
  if (query.onShift !== undefined) where.onShift = query.onShift === 'true';

  if (query.q) {
    const like = { contains: query.q, mode: 'insensitive' as const };
    where.OR = [{ name: like }, { code: like }, { mobile: like }];
  }

  const drivers = await repo.findDriversWithLoad(where);

  return {
    data: await Promise.all(
      drivers.map(async (d) => ({
        id: d.id,
        name: d.name,
        code: d.code,
        mobile: d.mobile,
        active: d.active,
        onShift: d.onShift,
        shiftStartedAt: d.shiftStartedAt,
        // Null while a shift is open; otherwise when the last one closed, so the
        // console can say "off shift since 18:40" rather than just "off shift".
        shiftEndedAt: d.shiftEndedAt,
        activeLoad: d._count.consignments,
        photoUrl: await signedUrl(d.photoPath),
      })),
    ),
  };
}

/* ------------------------------------------------------------ roster writes */

/** One driver for the Drivers tab, with signed document links. */
export async function getDriver(id: string) {
  const d = await repo.findDriverDetail(id);
  if (!d) throw AppError.notFound('Driver not found');

  const [photoUrl, idCardUrl] = await Promise.all([
    signedUrl(d.photoPath),
    signedUrl(d.idCardPath),
  ]);

  return {
    id: d.id,
    name: d.name,
    code: d.code,
    mobile: d.mobile,
    email: d.email,
    active: d.active,
    onShift: d.onShift,
    shiftStartedAt: d.shiftStartedAt,
    shiftEndedAt: d.shiftEndedAt,
    activeLoad: d._count.consignments,
    /** The linked login, if one was ever created. Accounts live under /api/users. */
    login: d.user,
    photoUrl,
    idCardUrl,
    hasPhoto: d.photoPath !== null,
    hasIdCard: d.idCardPath !== null,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

export async function createDriver(input: CreateDriverInput) {
  // Claim a map colour up front so the read path never falls back to hashing the
  // id. The palette is not unique: once all eight are taken the least-used is
  // reused, so a ninth driver is still created rather than failing.
  const mapColorIndex = await nextColorIndex();
  const created = await repo.createDriver({ ...input, mapColorIndex });
  return getDriver(created.id);
}

export async function updateDriver(id: string, input: UpdateDriverInput) {
  const existing = await repo.findDriverDetail(id);
  if (!existing) throw AppError.notFound('Driver not found');

  const { active, ...rest } = input;
  if (Object.keys(rest).length > 0) await repo.updateDriver(id, rest);
  // Separate call on purpose: deactivating has to close an open shift, which is
  // a transaction, not a column write.
  if (active !== undefined && active !== existing.active) await repo.setDriverActive(id, active);

  return getDriver(id);
}

/* --------------------------------------------------------------- documents */

const DOC_FIELD = { photo: 'photoPath', 'id-card': 'idCardPath' } as const;

/** Both links in one call, so the tab and the map need a single request. */
export async function driverDocuments(id: string) {
  const d = await repo.findDocPaths(id);
  if (!d) throw AppError.notFound('Driver not found');

  const [photoUrl, idCardUrl] = await Promise.all([
    signedUrl(d.photoPath),
    signedUrl(d.idCardPath),
  ]);
  return { driverId: d.id, photoUrl, idCardUrl };
}

/**
 * Store a photo or an ID card, replacing whatever was there.
 *
 * Storage first, then the column — the reverse would leave a row pointing at a
 * file that was never written. The old object is removed only once the new path
 * is committed, so a failed swap leaves the previous document intact.
 */
export async function putDriverDocument(id: string, kind: DriverDocKind, file?: Express.Multer.File) {
  if (!file) throw AppError.badRequest('Attach the image as the "file" field');

  const d = await repo.findDocPaths(id);
  if (!d) throw AppError.notFound('Driver not found');

  // The declared Content-Type was only an early reject; the bytes decide.
  const sniffed = sniffImage(file.buffer);
  if (!sniffed) throw AppError.badRequest('That file is not a PNG, JPEG or WebP image');

  const field = DOC_FIELD[kind];
  const previous = d[field];

  const path = objectPath(id, kind, sniffed.ext);
  await uploadObject(path, file.buffer, sniffed.mime);
  await repo.setDocPath(id, field, path);
  if (previous && previous !== path) await removeObjects([previous]);

  return driverDocuments(id);
}
