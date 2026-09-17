import type { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma.js';

/** What every endpoint returns; the usage count is what the admin screen decides on. */
export const clientSelect = {
  id: true,
  name: true,
  code: true,
  active: true,
  contactName: true,
  phone: true,
  email: true,
  line1: true,
  city: true,
  province: true,
  postcode: true,
  lat: true,
  lng: true,
  instructions: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { consignments: true } },
} satisfies Prisma.ClientSelect;

export type ClientRow = Prisma.ClientGetPayload<{ select: typeof clientSelect }>;

export function list(includeInactive: boolean): Promise<ClientRow[]> {
  return prisma.client.findMany({
    where: includeInactive ? {} : { active: true },
    select: clientSelect,
    orderBy: { name: 'asc' },
  });
}

export function findById(id: string): Promise<ClientRow | null> {
  return prisma.client.findUnique({ where: { id }, select: clientSelect });
}

export function findByName(name: string) {
  return prisma.client.findFirst({
    where: { name: { equals: name, mode: 'insensitive' } },
    select: { id: true, name: true },
  });
}

export function findByCode(code: string) {
  return prisma.client.findFirst({
    where: { code: { equals: code, mode: 'insensitive' } },
    select: { id: true, code: true },
  });
}

export function create(data: Prisma.ClientCreateInput): Promise<ClientRow> {
  return prisma.client.create({ data, select: clientSelect });
}

export function update(id: string, data: Prisma.ClientUpdateInput): Promise<ClientRow> {
  return prisma.client.update({ where: { id }, data, select: clientSelect });
}

/**
 * Only ever reached for a client with no orders — the service checks first.
 * The order counters go with it: they are number allocators and mean nothing
 * once the client they counted for is gone, but the FK would still block the
 * delete if they were left behind.
 */
export function remove(id: string) {
  return prisma.$transaction(async (tx) => {
    await tx.orderCounter.deleteMany({ where: { clientId: id } });
    await tx.client.delete({ where: { id } });
  });
}
