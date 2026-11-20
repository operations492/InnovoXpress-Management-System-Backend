import { AppError } from '../../utils/httpError.js';
import type {
  CreateAdditionalServiceInput,
  UpdateAdditionalServiceInput,
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
    /** Decimal to number for JSON; null means "no standard price". */
    defaultRate: row.defaultRate === null ? null : Number(row.defaultRate.toString()),
    trigger: row.trigger,
    /** Always present, even on a manual charge, so the console needs no null check. */
    hours: {
      weekdayFrom: row.weekdayFrom,
      weekdayTo: row.weekdayTo,
      weekendFrom: row.weekendFrom,
      weekendTo: row.weekendTo,
    },
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

export async function createAdditionalService(input: CreateAdditionalServiceInput) {
  await assertNameFree(input.name);
  const sortOrder = input.sortOrder ?? (await repo.nextSortOrder());
  return toDto(
    await repo.create({
      name: input.name,
      sortOrder,
      ...(input.defaultRate !== undefined ? { defaultRate: input.defaultRate } : {}),
    }),
  );
}

export async function updateAdditionalService(id: string, input: UpdateAdditionalServiceInput) {
  const existing = await repo.findById(id);
  if (!existing) throw AppError.notFound('Additional service not found');
  if (input.name !== undefined) await assertNameFree(input.name, id);

  // Hours only mean something to a charge the system applies by itself; on a
  // charge an operator ticks they would be a setting that silently does nothing.
  if (input.hours !== undefined && existing.trigger === 'MANUAL') {
    throw AppError.badRequest('Only a system-added charge keeps business hours');
  }

  return toDto(
    await repo.update(id, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
      ...(input.defaultRate !== undefined ? { defaultRate: input.defaultRate } : {}),
      ...(input.hours !== undefined
        ? {
            weekdayFrom: input.hours?.weekdayFrom ?? null,
            weekdayTo: input.hours?.weekdayTo ?? null,
            weekendFrom: input.hours?.weekendFrom ?? null,
            weekendTo: input.hours?.weekendTo ?? null,
          }
        : {}),
    }),
  );
}

export async function deleteAdditionalService(id: string) {
  const existing = await repo.findById(id);
  if (!existing) throw AppError.notFound('Additional service not found');
  // The automatic charge is part of how pricing works rather than something
  // somebody chose to add, so it is hidden, never deleted out from under a card.
  if (existing.trigger !== 'MANUAL') {
    throw AppError.conflict('A system-added charge cannot be deleted; switch it off instead');
  }
  await repo.remove(id);
}
