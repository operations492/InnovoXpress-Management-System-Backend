import { AppError } from '../../utils/httpError.js';
import type {
  CreateCatalogEntryInput,
  UpdateCatalogEntryInput,
} from '../../schemas/catalog.schema.js';
import * as repo from './additionalServices.repository.js';

/*
 * Additional services are a business-managed list of priced extras: "Tailgate",
 * "Inside Delivery", "Wait Time". Admins maintain it from the console; a rate
 * plan attaches a per-client price to each entry.
 *
 * Names are unique case-insensitively, so "tailgate" and "Tailgate" cannot both
 * exist and split the pricing. Deletion is a plain delete for now because
 * nothing references these rows yet — once rate plans and order selections do,
 * the FK becomes Restrict and this needs the same "deactivate instead" 409 that
 * service levels return.
 */

function toDto(row: repo.EntryRow) {
  return {
    id: row.id,
    name: row.name,
    active: row.active,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listAdditionalServices(includeInactive: boolean) {
  const rows = await repo.list(includeInactive);
  return rows.map(toDto);
}

export async function getAdditionalService(id: string) {
  const row = await repo.findById(id);
  if (!row) throw AppError.notFound('Additional service not found');
  return toDto(row);
}

async function assertNameFree(name: string, exceptId?: string) {
  const clash = await repo.findByName(name);
  if (clash && clash.id !== exceptId) {
    throw AppError.conflict(`An additional service named "${clash.name}" already exists`);
  }
}

export async function createAdditionalService(input: CreateCatalogEntryInput) {
  await assertNameFree(input.name);
  const sortOrder = input.sortOrder ?? (await repo.nextSortOrder());
  return toDto(await repo.create({ name: input.name, sortOrder }));
}

export async function updateAdditionalService(id: string, input: UpdateCatalogEntryInput) {
  const existing = await repo.findById(id);
  if (!existing) throw AppError.notFound('Additional service not found');
  if (input.name !== undefined) await assertNameFree(input.name, id);

  return toDto(
    await repo.update(id, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
    }),
  );
}

export async function deleteAdditionalService(id: string) {
  const existing = await repo.findById(id);
  if (!existing) throw AppError.notFound('Additional service not found');
  await repo.remove(id);
}
