import { AppError } from '../../utils/httpError.js';
import { toClientAddress } from '../../utils/clientAddress.js';
import type {
  ClientAddressInput,
  CreateClientInput,
  UpdateClientInput,
} from '../../schemas/client.schema.js';
import * as repo from './clients.repository.js';

/*
 * Clients are the companies whose parcels move. Admins maintain the list from
 * the console; every consignment belongs to exactly one.
 *
 * Three rules carry the design:
 *  - name and code are unique case-insensitively, so "TCS" and "tcs" cannot
 *    both exist and split the reports;
 *  - the code is frozen once the client has orders. It is stamped into every
 *    order number already issued and into the order counters, and changing it
 *    would leave DRZ-20260813-0001 belonging to a client now called something
 *    else. Rename freely; recode only while the slate is clean;
 *  - a client any order has used is never deleted — the FK is Restrict and this
 *    service says so with a 409 before Postgres has to. Deactivate instead: it
 *    leaves the dropdown and history stays intact.
 *
 * The default pickup address is a value object, replaced wholesale. Sending
 * `address` sets all ten columns, `address: null` clears them, and omitting it
 * leaves them alone. There is no field-by-field merge, which is what keeps a
 * sequence of valid updates from adding up to an address with no coordinates.
 */

function toDto(row: repo.ClientRow) {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    active: row.active,
    /** Null until it is complete enough to prefill an order and route it. */
    address: toClientAddress(row),
    /** How many orders reference it. Zero means Delete is allowed. */
    usageCount: row._count.consignments,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Explicit nulls, not `undefined` — Prisma treats undefined as "leave alone". */
function addressColumns(address: ClientAddressInput | null) {
  if (address === null) {
    return {
      contactName: null,
      phone: null,
      email: null,
      line1: null,
      city: null,
      province: null,
      postcode: null,
      lat: null,
      lng: null,
      instructions: null,
    };
  }
  return {
    contactName: address.contactName ?? null,
    phone: address.phone ?? null,
    email: address.email ?? null,
    line1: address.line1,
    city: address.city,
    province: address.province ?? null,
    postcode: address.postcode ?? null,
    lat: address.lat,
    lng: address.lng,
    instructions: address.instructions ?? null,
  };
}

export async function listClients(includeInactive: boolean) {
  const rows = await repo.list(includeInactive);
  return rows.map(toDto);
}

export async function getClient(id: string) {
  const row = await repo.findById(id);
  if (!row) throw AppError.notFound('Client not found');
  return toDto(row);
}

async function assertNameFree(name: string, exceptId?: string) {
  const clash = await repo.findByName(name);
  if (clash && clash.id !== exceptId) {
    throw AppError.conflict(`A client named "${clash.name}" already exists`);
  }
}

async function assertCodeFree(code: string, exceptId?: string) {
  const clash = await repo.findByCode(code);
  if (clash && clash.id !== exceptId) {
    throw AppError.conflict(`The code "${clash.code}" is already taken`);
  }
}

export async function createClient(input: CreateClientInput) {
  await assertNameFree(input.name);
  await assertCodeFree(input.code);

  return toDto(
    await repo.create({
      name: input.name,
      code: input.code,
      ...(input.address !== undefined ? addressColumns(input.address) : {}),
    }),
  );
}

export async function updateClient(id: string, input: UpdateClientInput) {
  const existing = await repo.findById(id);
  if (!existing) throw AppError.notFound('Client not found');

  if (input.name !== undefined) await assertNameFree(input.name, id);

  if (input.code !== undefined && input.code !== existing.code) {
    if (existing._count.consignments > 0) {
      throw AppError.conflict(
        `"${existing.name}" has ${existing._count.consignments} order(s) numbered ${existing.code}-… — the code cannot change`,
      );
    }
    await assertCodeFree(input.code, id);
  }

  return toDto(
    await repo.update(id, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.code !== undefined ? { code: input.code } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
      ...(input.address !== undefined ? addressColumns(input.address) : {}),
    }),
  );
}

export async function deleteClient(id: string) {
  const existing = await repo.findById(id);
  if (!existing) throw AppError.notFound('Client not found');
  if (existing._count.consignments > 0) {
    throw AppError.conflict(
      `"${existing.name}" is used by ${existing._count.consignments} order(s) — deactivate it instead`,
    );
  }
  await repo.remove(id);
}
