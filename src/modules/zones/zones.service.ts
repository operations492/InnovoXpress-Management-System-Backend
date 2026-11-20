import { AppError } from '../../utils/httpError.js';
import type {
  CreateZoneInput,
  CreateZoneListInput,
  UpdateZoneInput,
  UpdateZoneListInput,
} from '../../schemas/zone.schema.js';
import {
  classifyPostalCode,
  fsaOf,
  normalizePostalCode,
  parsePostalList,
} from '../../utils/postalCode.js';
import * as repo from './zones.repository.js';

/*
 * A zone list is one customer's map of the country: "Apple Express Zones", with
 * Toronto, Timmins and Vancouver inside it. A rate card points at a list, so two
 * customers can draw the same city differently and neither sees the other's.
 *
 * One rule carries the whole design: within a list, a postal code belongs to
 * exactly ONE zone. Without it "which zone is this address in" would have more
 * than one answer and a price would depend on which row was read first. The
 * unique index enforces it; the preview below exists so an operator is told
 * which zone already holds the code instead of being shown a constraint name.
 *
 * A six-character code and its own FSA are different codes, so `T2E6W5` may sit
 * in "YYC Airport" while `T2E` sits in "Calgary". That is not a conflict — it is
 * how a carve-out is expressed, and `resolveZone` prefers the longer match.
 */

function toListDto(row: repo.ZoneListRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    active: row.active,
    zoneCount: row._count.zones,
    codeCount: row._count.rules,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toZoneDto(row: repo.ZoneRow) {
  return {
    id: row.id,
    zoneListId: row.zoneListId,
    name: row.name,
    shortName: row.shortName,
    active: row.active,
    codeCount: row._count.rules,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toCodeDto(row: repo.CodeRow) {
  return { id: row.id, code: row.code, codeType: row.codeType, source: row.source };
}

/* ------------------------------------------------------------------ lists */

export async function listZoneLists(includeInactive: boolean) {
  const rows = await repo.listLists(includeInactive);
  return rows.map(toListDto);
}

async function listOr404(id: string) {
  const row = await repo.findListById(id);
  if (!row) throw AppError.notFound('Zone list not found');
  return row;
}

export async function getZoneList(id: string, includeInactive: boolean) {
  const list = await listOr404(id);
  const zones = await repo.listZones(id, includeInactive);
  return { ...toListDto(list), zones: zones.map(toZoneDto) };
}

async function assertListNameFree(name: string, exceptId?: string) {
  const clash = await repo.findListByName(name);
  if (clash && clash.id !== exceptId) {
    throw AppError.conflict(`A zone list named "${clash.name}" already exists`);
  }
}

export async function createZoneList(input: CreateZoneListInput) {
  await assertListNameFree(input.name);
  return toListDto(
    await repo.createList({
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
    }),
  );
}

export async function updateZoneList(id: string, input: UpdateZoneListInput) {
  await listOr404(id);
  if (input.name !== undefined) await assertListNameFree(input.name, id);

  return toListDto(
    await repo.updateList(id, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
    }),
  );
}

export async function deleteZoneList(id: string) {
  await listOr404(id);
  const cards = await repo.countCardsUsing(id);
  if (cards > 0) {
    throw AppError.conflict(
      `This zone list is used by ${cards} rate card${cards === 1 ? '' : 's'}; deactivate it instead`,
    );
  }
  await repo.deleteList(id);
}

/* ------------------------------------------------------------------ zones */

async function zoneOr404(zoneListId: string, zoneId: string) {
  const zone = await repo.findZoneById(zoneId);
  // A zone from another list is reported as missing rather than as forbidden:
  // the URL claims it belongs here, and it does not.
  if (!zone || zone.zoneListId !== zoneListId) throw AppError.notFound('Zone not found');
  return zone;
}

export async function getZone(zoneListId: string, zoneId: string) {
  const zone = await zoneOr404(zoneListId, zoneId);
  const [codes, shape] = await Promise.all([repo.listCodes(zoneId), repo.findShape(zoneId)]);
  return {
    ...toZoneDto(zone),
    codes: codes.map(toCodeDto),
    shape: shape ? { geojson: shape.geojson, updatedAt: shape.updatedAt } : null,
  };
}

async function assertZoneNameFree(zoneListId: string, name: string, exceptId?: string) {
  const clash = await repo.findZoneByName(zoneListId, name);
  if (clash && clash.id !== exceptId) {
    throw AppError.conflict(`This list already has a zone named "${clash.name}"`);
  }
}

export async function createZone(zoneListId: string, input: CreateZoneInput) {
  await listOr404(zoneListId);
  await assertZoneNameFree(zoneListId, input.name);
  return toZoneDto(
    await repo.createZone({
      zoneListId,
      name: input.name,
      ...(input.shortName !== undefined ? { shortName: input.shortName } : {}),
    }),
  );
}

export async function updateZone(zoneListId: string, zoneId: string, input: UpdateZoneInput) {
  await zoneOr404(zoneListId, zoneId);
  if (input.name !== undefined) await assertZoneNameFree(zoneListId, input.name, zoneId);

  return toZoneDto(
    await repo.updateZone(zoneId, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.shortName !== undefined ? { shortName: input.shortName } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
    }),
  );
}

/**
 * Removing a zone that a rate card prices would leave that price pointing at
 * nothing, so it is deactivated instead and the caller is told which happened.
 */
export async function deleteZone(zoneListId: string, zoneId: string) {
  await zoneOr404(zoneListId, zoneId);
  const rates = await repo.countRatesUsing(zoneId);
  if (rates > 0) {
    return { deleted: false, zone: toZoneDto(await repo.updateZone(zoneId, { active: false })) };
  }
  await repo.deleteZone(zoneId);
  return { deleted: true };
}

/* ------------------------------------------------------------------ codes */

export interface CodePreview {
  valid: Array<{ code: string; codeType: 'FSA' | 'FULL' }>;
  invalid: string[];
  duplicates: string[];
  conflicts: Array<{ code: string; zoneId: string; zoneName: string }>;
  /** How many would actually be stored if this were saved. */
  savable: number;
}

async function preview(zoneListId: string, zoneId: string, text: string): Promise<CodePreview> {
  const parsed = parsePostalList(text);
  const rows = await repo.findConflicts(
    zoneListId,
    parsed.valid.map((c) => c.code),
    zoneId,
  );
  const conflicts = rows.map((r) => ({ code: r.code, zoneId: r.zone.id, zoneName: r.zone.name }));
  const taken = new Set(conflicts.map((c) => c.code));

  return {
    valid: parsed.valid.map((c) => ({ code: c.code, codeType: c.type })),
    invalid: parsed.invalid,
    duplicates: parsed.duplicates,
    conflicts,
    savable: parsed.valid.filter((c) => !taken.has(c.code)).length,
  };
}

/** What would happen if this box were saved. Writes nothing. */
export async function previewCodes(zoneListId: string, zoneId: string, text: string) {
  await zoneOr404(zoneListId, zoneId);
  return preview(zoneListId, zoneId, text);
}

/**
 * Save the box. Blocked outright while any code belongs to another zone — a
 * half-applied paste is worse than a rejected one, because the operator would
 * have to work out which half landed.
 */
export async function saveCodes(zoneListId: string, zoneId: string, text: string) {
  await zoneOr404(zoneListId, zoneId);
  const result = await preview(zoneListId, zoneId, text);

  if (result.conflicts.length > 0) conflictError(result.conflicts);

  const parsed = parsePostalList(text);
  const codes = await repo.replaceTypedCodes(zoneId, zoneListId, parsed.valid);
  return {
    ...result,
    codes: codes.map(toCodeDto),
  };
}

/* ------------------------------------------------------------- the map */

export interface ShapePreview {
  /** FSAs lying wholly inside the drawn shape. Ticked by default. */
  inside: Array<{ code: string; coveragePct: number }>;
  /**
   * FSAs the shape only clips.
   *
   * Unticked by default, and offered rather than decided. Narrowing a clipped
   * FSA to the six-character codes actually inside the shape needs Canada Post's
   * licensed point file, which this install does not have; taking the whole FSA
   * would claim streets nobody drew, and dropping it would lose streets they
   * did. So the operator is shown how much of it is covered and chooses.
   */
  partial: Array<{ code: string; coveragePct: number }>;
  conflicts: Array<{ code: string; zoneId: string; zoneName: string }>;
}

function conflictError(conflicts: Array<{ code: string; zoneName: string }>): never {
  const first = conflicts
    .slice(0, 3)
    .map((c) => `${c.code} is in "${c.zoneName}"`)
    .join(', ');
  const more = conflicts.length - Math.min(3, conflicts.length);
  throw AppError.conflict(
    `Nothing was saved: ${first}${more > 0 ? ` and ${more} more` : ''}. ` +
      'A postal code can belong to only one zone in a list.',
  );
}

async function requireBoundaries() {
  if ((await repo.boundaryCount()) === 0) {
    throw AppError.conflict(
      'No FSA boundaries are loaded. Run `npx tsx prisma/loadFsaBoundaries.ts <fsa.geojson>` first.',
    );
  }
}

/** Which postal codes a drawn shape covers. Writes nothing. */
export async function previewShape(
  zoneListId: string,
  zoneId: string,
  geojson: unknown,
): Promise<ShapePreview> {
  await zoneOr404(zoneListId, zoneId);
  await requireBoundaries();

  const hits = await repo.fsasTouching(geojson);
  const rows = await repo.findConflicts(
    zoneListId,
    hits.map((h) => h.code),
    zoneId,
  );

  return {
    inside: hits
      .filter((h) => h.fullyInside)
      .map((h) => ({ code: h.code, coveragePct: h.coveragePct, part: h.part })),
    partial: hits
      .filter((h) => !h.fullyInside)
      .map((h) => ({ code: h.code, coveragePct: h.coveragePct, part: h.part })),
    conflicts: rows.map((r) => ({ code: r.code, zoneId: r.zone.id, zoneName: r.zone.name })),
  };
}

/**
 * Store the drawing and the codes the operator kept.
 *
 * The codes are taken from the request rather than re-derived from the shape,
 * because unticking one in the preview has to mean something. They are still
 * checked for conflicts here — the preview is a courtesy, not a guarantee, and
 * another zone may have taken a code in between.
 */
export async function saveShape(
  zoneListId: string,
  zoneId: string,
  geojson: unknown,
  rawCodes: string[],
) {
  await zoneOr404(zoneListId, zoneId);

  const codes: Array<{ code: string; type: 'FSA' | 'FULL' }> = [];
  const seen = new Set<string>();
  for (const raw of rawCodes) {
    const code = normalizePostalCode(raw);
    const type = classifyPostalCode(code);
    if (!type) throw AppError.badRequest(`"${raw}" is not a postal code`);
    if (seen.has(code)) continue;
    seen.add(code);
    codes.push({ code, type });
  }

  const conflicts = await repo.findConflicts(
    zoneListId,
    codes.map((c) => c.code),
    zoneId,
  );
  if (conflicts.length > 0) {
    conflictError(conflicts.map((c) => ({ code: c.code, zoneName: c.zone.name })));
  }

  // Welded here rather than while drawing: overlaps only matter at the moment
  // the shape is written, and doing it on every preview would spend a PostGIS
  // call to tell the operator something they can see on the map.
  const tidy = await repo.normaliseShape(geojson);
  const shape = await repo.upsertShape(zoneId, tidy as never);
  const stored = await repo.replaceMapCodes(zoneId, zoneListId, codes);
  return {
    shape: { geojson: shape.geojson, updatedAt: shape.updatedAt },
    codes: stored.map(toCodeDto),
  };
}

/**
 * Forget the drawing. The codes it produced stay exactly as they are, because
 * they are what pricing reads — erasing the picture must not reprice anything.
 */
export async function removeShape(zoneListId: string, zoneId: string) {
  await zoneOr404(zoneListId, zoneId);
  await repo.deleteShape(zoneId);
}

export async function removeCode(zoneListId: string, zoneId: string, rawCode: string) {
  await zoneOr404(zoneListId, zoneId);
  const code = normalizePostalCode(rawCode);
  if (!classifyPostalCode(code)) throw AppError.badRequest(`"${rawCode}" is not a postal code`);

  const { count } = await repo.deleteCode(zoneId, code);
  if (count === 0) throw AppError.notFound(`${code} is not in this zone`);
}

/* --------------------------------------------------------------- resolving */

export type ZoneResolution =
  | { ok: true; zoneId: string; zoneName: string; matched: string; via: 'FULL' | 'FSA' }
  | { ok: false; reason: 'INVALID_POSTAL_CODE' | 'ZONE_NOT_FOUND' };

/**
 * Which zone of this list an address falls in. Text matching only — no map, no
 * coordinates, so the answer cannot drift when a boundary file is updated.
 *
 * A full code beats the FSA it sits inside, which is what makes a carve-out
 * work. Pricing turns the failure reasons into its own error codes.
 */
/**
 * The same question, asked by the rate calculator, which lets an operator type
 * just an FSA. Real pricing keeps using `resolveZone`: a job carries a full
 * address, and half a postcode there means a typo, not a shortcut.
 */
export async function resolveZoneLoose(zoneListId: string, raw: string): Promise<ZoneResolution> {
  const code = normalizePostalCode(raw);
  if (classifyPostalCode(code) === 'FULL') return resolveZone(zoneListId, code);
  if (classifyPostalCode(code) !== 'FSA') return { ok: false, reason: 'INVALID_POSTAL_CODE' };

  const rows = await repo.findMatchingRules(zoneListId, code, code);
  const hit = rows.find((r) => r.code === code);
  if (!hit) return { ok: false, reason: 'ZONE_NOT_FOUND' };

  return { ok: true, zoneId: hit.zone.id, zoneName: hit.zone.name, matched: hit.code, via: hit.codeType };
}

export async function resolveZone(zoneListId: string, raw: string): Promise<ZoneResolution> {
  const code = normalizePostalCode(raw);
  if (classifyPostalCode(code) !== 'FULL') return { ok: false, reason: 'INVALID_POSTAL_CODE' };

  const fsa = fsaOf(code);
  const rows = await repo.findMatchingRules(zoneListId, code, fsa);
  const hit = rows.find((r) => r.code === code) ?? rows.find((r) => r.code === fsa);
  if (!hit) return { ok: false, reason: 'ZONE_NOT_FOUND' };

  return {
    ok: true,
    zoneId: hit.zone.id,
    zoneName: hit.zone.name,
    matched: hit.code,
    via: hit.codeType,
  };
}
