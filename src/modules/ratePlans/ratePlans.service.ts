import { AppError } from '../../utils/httpError.js';
import type {
  CreateRatePlanInput,
  SetRatePlanItemsInput,
  UpdateRatePlanInput,
} from '../../schemas/ratePlan.schema.js';
import * as repo from './ratePlans.repository.js';

/*
 * A rate plan is one client's price list.
 *
 * Three rules carry the design:
 *  - exactly one plan per client may be active, so there is never a question
 *    about which price applied. A second active plan is a 409, not a silent
 *    swap; draft a replacement with active:false and flip it when ready.
 *  - the base-rate numbers live on the plan, not per service level: baseRate
 *    covers includedKm, and each further blockKm costs blockRate.
 *  - a missing grid row means "not priced for this client"; a row priced at 0
 *    means deliberately free. The editor payload returns null for the first and
 *    0 for the second, and the quote treats them differently.
 */

/** Prisma Decimal serialises as a string; the console wants a number. */
const toNumber = (d: unknown) => Number(d);

function toPlanDto(row: repo.PlanRow) {
  return {
    id: row.id,
    clientId: row.clientId,
    client: row.client,
    name: row.name,
    active: row.active,
    currency: row.currency,
    baseRate: toNumber(row.baseRate),
    includedKm: row.includedKm,
    blockKm: row.blockKm,
    blockRate: toNumber(row.blockRate),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listRatePlans(filter: { clientId?: string; includeInactive: boolean }) {
  const rows = await repo.list(filter);
  return rows.map(toPlanDto);
}

/**
 * The editor payload: the plan plus **every active catalogue entry**, priced or
 * not. One call feeds all four tabs, so no tab can disagree with another.
 */
export async function getRatePlan(id: string) {
  const plan = await repo.findById(id);
  if (!plan) throw AppError.notFound('Rate plan not found');

  const [items, catalogues] = await Promise.all([repo.findItems(id), repo.findCatalogues()]);

  const priceBy = (key: 'serviceLevelId' | 'additionalServiceId' | 'freightItemId') => {
    const map = new Map<string, number>();
    for (const i of items) {
      const ref = i[key];
      if (ref) map.set(ref, toNumber(i.price));
    }
    return map;
  };

  const merge = (
    entries: Array<{ id: string; name: string }>,
    prices: Map<string, number>,
  ) => entries.map((e) => ({ ...e, price: prices.get(e.id) ?? null }));

  return {
    ...toPlanDto(plan),
    serviceLevels: merge(catalogues.serviceLevels, priceBy('serviceLevelId')),
    additionalServices: merge(catalogues.additionalServices, priceBy('additionalServiceId')),
    freightItems: merge(catalogues.freightItems, priceBy('freightItemId')),
  };
}

async function assertNameFree(clientId: string, name: string, exceptId?: string) {
  const clash = await repo.findByClientAndName(clientId, name);
  if (clash && clash.id !== exceptId) {
    throw AppError.conflict(`This client already has a plan named "${clash.name}"`);
  }
}

async function assertNoOtherActive(clientId: string, clientName: string, exceptId?: string) {
  const live = await repo.findActiveForClient(clientId, exceptId);
  if (live) {
    throw AppError.conflict(
      `${clientName} already has an active plan ("${live.name}") — deactivate it first`,
    );
  }
}

export async function createRatePlan(input: CreateRatePlanInput) {
  const client = await repo.findClientById(input.clientId);
  if (!client) throw AppError.badRequest('Unknown client');

  await assertNameFree(client.id, input.name);

  const active = input.active ?? true;
  if (active) await assertNoOtherActive(client.id, client.name);

  return toPlanDto(
    await repo.create({ name: input.name, active, client: { connect: { id: client.id } } }),
  );
}

export async function updateRatePlan(id: string, input: UpdateRatePlanInput) {
  const existing = await repo.findById(id);
  if (!existing) throw AppError.notFound('Rate plan not found');

  if (input.name !== undefined) await assertNameFree(existing.clientId, input.name, id);
  if (input.active === true && !existing.active) {
    await assertNoOtherActive(existing.clientId, existing.client.name, id);
  }

  return toPlanDto(
    await repo.update(id, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
      ...(input.currency !== undefined ? { currency: input.currency } : {}),
      ...(input.baseRate !== undefined ? { baseRate: input.baseRate } : {}),
      ...(input.includedKm !== undefined ? { includedKm: input.includedKm } : {}),
      ...(input.blockKm !== undefined ? { blockKm: input.blockKm } : {}),
      ...(input.blockRate !== undefined ? { blockRate: input.blockRate } : {}),
    }),
  );
}

export async function setRatePlanItems(id: string, input: SetRatePlanItemsInput) {
  const plan = await repo.findById(id);
  if (!plan) throw AppError.notFound('Rate plan not found');

  // Every id must be a real, active catalogue entry, and may appear once.
  const catalogues = await repo.findCatalogues();
  const known = {
    serviceLevelId: new Set(catalogues.serviceLevels.map((e) => e.id)),
    additionalServiceId: new Set(catalogues.additionalServices.map((e) => e.id)),
    freightItemId: new Set(catalogues.freightItems.map((e) => e.id)),
  } as const;

  const seen = new Set<string>();
  for (const row of input.items) {
    for (const key of ['serviceLevelId', 'additionalServiceId', 'freightItemId'] as const) {
      const ref = row[key];
      if (!ref) continue;
      if (!known[key].has(ref)) {
        throw AppError.badRequest(`Unknown or inactive ${key}: ${ref}`);
      }
      if (seen.has(ref)) throw AppError.badRequest(`${ref} is priced twice`);
      seen.add(ref);
    }
  }

  await repo.replaceItems(id, input.items);
  return getRatePlan(id);
}

export async function deleteRatePlan(id: string) {
  const existing = await repo.findById(id);
  if (!existing) throw AppError.notFound('Rate plan not found');
  await repo.remove(id);
}
