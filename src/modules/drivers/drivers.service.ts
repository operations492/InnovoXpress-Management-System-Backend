import type { Prisma } from '@prisma/client';
import type { DriversQuery } from '../../schemas/assignment.schema.js';
import * as repo from './drivers.repository.js';

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
    data: drivers.map((d) => ({
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
    })),
  };
}
