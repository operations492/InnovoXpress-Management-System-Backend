import { AppError } from '../../utils/httpError.js';
import type {
  CreateCatalogEntryInput,
  UpdateCatalogEntryInput,
} from '../../schemas/catalog.schema.js';
import * as repo from './freightItems.repository.js';

/*
 * Freight items are the priceable *types* of goods: "Skid", "Carton",
 * "Envelope". They are not the same thing as `Item`, which is one physical line
 * on one order — this is the catalogue a rate plan attaches a price to.
 *
 * Names are unique case-insensitively. Deletion is a plain delete for now
 * because nothing references these rows yet; once rate plans and order lines do,
 * the FK becomes Restrict and this needs the "deactivate instead" 409 that
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

export async function listFreightItems(includeInactive: boolean) {
  const rows = await repo.list(includeInactive);
  return rows.map(toDto);
}

export async function getFreightItem(id: string) {
  const row = await repo.findById(id);
  if (!row) throw AppError.notFound('Freight item not found');
  return toDto(row);
}

async function assertNameFree(name: string, exceptId?: string) {
  const clash = await repo.findByName(name);
  if (clash && clash.id !== exceptId) {
    throw AppError.conflict(`A freight item named "${clash.name}" already exists`);
  }
}

export async function createFreightItem(input: CreateCatalogEntryInput) {
  await assertNameFree(input.name);
  const sortOrder = input.sortOrder ?? (await repo.nextSortOrder());
  return toDto(await repo.create({ name: input.name, sortOrder }));
}

export async function updateFreightItem(id: string, input: UpdateCatalogEntryInput) {
  const existing = await repo.findById(id);
  if (!existing) throw AppError.notFound('Freight item not found');
  if (input.name !== undefined) await assertNameFree(input.name, id);

  return toDto(
    await repo.update(id, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
    }),
  );
}

export async function deleteFreightItem(id: string) {
  const existing = await repo.findById(id);
  if (!existing) throw AppError.notFound('Freight item not found');
  await repo.remove(id);
}
