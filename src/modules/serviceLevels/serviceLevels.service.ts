import { AppError } from '../../utils/httpError.js';
import type {
  CreateServiceLevelInput,
  UpdateServiceLevelInput,
} from '../../schemas/serviceLevel.schema.js';
import * as repo from './serviceLevels.repository.js';

/*
 * Service levels are a business-managed list: "5 Ton Truck", "Expedite", "Non
 * Stop - Car". Admins maintain it from the console; orders reference a row by
 * id so a rename reaches every order that used it.
 *
 * Two rules carry the design:
 *  - names are unique, case-insensitively, so "expedite" and "Expedite" cannot
 *    both exist and split the reports;
 *  - a level that any order has used is never deleted — the FK is Restrict and
 *    this service says so with a 409 before Postgres has to. Deactivate instead:
 *    it leaves the dropdown, and history stays intact.
 */

function toDto(row: repo.LevelRow) {
  return {
    id: row.id,
    name: row.name,
    active: row.active,
    sortOrder: row.sortOrder,
    /** How many orders reference it. Zero means Delete is allowed. */
    usageCount: row._count.consignments,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listServiceLevels(includeInactive: boolean) {
  const rows = await repo.list(includeInactive);
  return rows.map(toDto);
}

export async function getServiceLevel(id: string) {
  const row = await repo.findById(id);
  if (!row) throw AppError.notFound('Service level not found');
  return toDto(row);
}

async function assertNameFree(name: string, exceptId?: string) {
  const clash = await repo.findByName(name);
  if (clash && clash.id !== exceptId) {
    throw AppError.conflict(`A service level named "${clash.name}" already exists`);
  }
}

export async function createServiceLevel(input: CreateServiceLevelInput) {
  await assertNameFree(input.name);
  const sortOrder = input.sortOrder ?? (await repo.nextSortOrder());
  return toDto(await repo.create({ name: input.name, sortOrder }));
}

export async function updateServiceLevel(id: string, input: UpdateServiceLevelInput) {
  const existing = await repo.findById(id);
  if (!existing) throw AppError.notFound('Service level not found');
  if (input.name !== undefined) await assertNameFree(input.name, id);

  return toDto(
    await repo.update(id, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
    }),
  );
}

export async function deleteServiceLevel(id: string) {
  const existing = await repo.findById(id);
  if (!existing) throw AppError.notFound('Service level not found');
  if (existing._count.consignments > 0) {
    throw AppError.conflict(
      `"${existing.name}" is used by ${existing._count.consignments} order(s) — deactivate it instead`,
    );
  }
  await repo.remove(id);
}
