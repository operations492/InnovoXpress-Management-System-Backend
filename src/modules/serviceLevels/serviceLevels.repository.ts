import type { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma.js';

/** What every endpoint returns; the usage count is what the admin screen decides on. */
export const levelSelect = {
  id: true,
  name: true,
  active: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { consignments: true } },
} satisfies Prisma.ServiceLevelSelect;

export type LevelRow = Prisma.ServiceLevelGetPayload<{ select: typeof levelSelect }>;

export function list(includeInactive: boolean): Promise<LevelRow[]> {
  return prisma.serviceLevel.findMany({
    where: includeInactive ? {} : { active: true },
    select: levelSelect,
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
}

export function findById(id: string): Promise<LevelRow | null> {
  return prisma.serviceLevel.findUnique({ where: { id }, select: levelSelect });
}

export function findByName(name: string) {
  return prisma.serviceLevel.findFirst({
    where: { name: { equals: name, mode: 'insensitive' } },
    select: { id: true, name: true },
  });
}

/** Next free slot at the end of the list. */
export async function nextSortOrder(): Promise<number> {
  const last = await prisma.serviceLevel.aggregate({ _max: { sortOrder: true } });
  return (last._max.sortOrder ?? -1) + 1;
}

export function create(data: { name: string; sortOrder: number }): Promise<LevelRow> {
  return prisma.serviceLevel.create({ data, select: levelSelect });
}

export function update(id: string, data: Prisma.ServiceLevelUpdateInput): Promise<LevelRow> {
  return prisma.serviceLevel.update({ where: { id }, data, select: levelSelect });
}

export function remove(id: string) {
  return prisma.serviceLevel.delete({ where: { id }, select: { id: true } });
}
