import { prisma } from '../../config/prisma.js';

/** All Prisma access for the reference lists that populate form dropdowns. */

export function findActiveClients() {
  return prisma.client.findMany({
    where: { active: true },
    select: { id: true, name: true, code: true },
    orderBy: { name: 'asc' },
  });
}

export function findActiveDrivers() {
  return prisma.driver.findMany({
    where: { active: true },
    select: { id: true, name: true, code: true, mobile: true },
    orderBy: { name: 'asc' },
  });
}
