import { prisma } from '../../config/prisma.js';
import { toClientAddress } from '../../utils/clientAddress.js';

/** All Prisma access for the reference lists that populate form dropdowns. */

export async function findActiveClients() {
  const rows = await prisma.client.findMany({
    where: { active: true },
    select: {
      id: true,
      name: true,
      code: true,
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
    },
    orderBy: { name: 'asc' },
  });

  // The console prefills a consignment's sender from the chosen client, so the
  // address rides along here rather than costing the form a request per client.
  return rows.map(({ id, name, code, ...address }) => ({
    id,
    name,
    code,
    address: toClientAddress(address),
  }));
}

export function findActiveServiceLevels() {
  return prisma.serviceLevel.findMany({
    where: { active: true },
    select: { id: true, name: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
}

export function findActiveDrivers() {
  return prisma.driver.findMany({
    where: { active: true },
    select: { id: true, name: true, code: true, mobile: true },
    orderBy: { name: 'asc' },
  });
}
