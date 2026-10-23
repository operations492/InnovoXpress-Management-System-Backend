import type { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma.js';

export const entrySelect = {
  id: true,
  name: true,
  active: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.FreightItemSelect;

export type EntryRow = Prisma.FreightItemGetPayload<{ select: typeof entrySelect }>;

export function list(includeInactive: boolean): Promise<EntryRow[]> {
  return prisma.freightItem.findMany({
    where: includeInactive ? {} : { active: true },
    select: entrySelect,
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
}

export function findById(id: string): Promise<EntryRow | null> {
  return prisma.freightItem.findUnique({ where: { id }, select: entrySelect });
}

export function findByName(name: string) {
  return prisma.freightItem.findFirst({
    where: { name: { equals: name, mode: 'insensitive' } },
    select: { id: true, name: true },
  });
}

/** Next free slot at the end of the list. */
export async function nextSortOrder(): Promise<number> {
  const last = await prisma.freightItem.aggregate({ _max: { sortOrder: true } });
  return (last._max.sortOrder ?? -1) + 1;
}

export function create(data: { name: string; sortOrder: number }): Promise<EntryRow> {
  return prisma.freightItem.create({ data, select: entrySelect });
}

export function update(id: string, data: Prisma.FreightItemUpdateInput): Promise<EntryRow> {
  return prisma.freightItem.update({ where: { id }, data, select: entrySelect });
}

export function remove(id: string) {
  return prisma.freightItem.delete({ where: { id }, select: { id: true } });
}
