import type { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma.js';
import type { PostalCodeType } from '../../utils/postalCode.js';

export const zoneListSelect = {
  id: true,
  name: true,
  description: true,
  active: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { zones: true, rules: true } },
} satisfies Prisma.ZoneListSelect;

export type ZoneListRow = Prisma.ZoneListGetPayload<{ select: typeof zoneListSelect }>;

export const zoneSelect = {
  id: true,
  zoneListId: true,
  name: true,
  shortName: true,
  active: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { rules: true } },
} satisfies Prisma.ZoneSelect;

export type ZoneRow = Prisma.ZoneGetPayload<{ select: typeof zoneSelect }>;

export const codeSelect = {
  id: true,
  code: true,
  codeType: true,
  source: true,
} satisfies Prisma.ZonePostalRuleSelect;

export type CodeRow = Prisma.ZonePostalRuleGetPayload<{ select: typeof codeSelect }>;

/* ------------------------------------------------------------------ lists */

export function listLists(includeInactive: boolean): Promise<ZoneListRow[]> {
  return prisma.zoneList.findMany({
    where: includeInactive ? {} : { active: true },
    select: zoneListSelect,
    orderBy: { name: 'asc' },
  });
}

export function findListById(id: string): Promise<ZoneListRow | null> {
  return prisma.zoneList.findUnique({ where: { id }, select: zoneListSelect });
}

export function findListByName(name: string) {
  return prisma.zoneList.findFirst({
    where: { name: { equals: name, mode: 'insensitive' } },
    select: { id: true, name: true },
  });
}

export function createList(data: { name: string; description?: string }): Promise<ZoneListRow> {
  return prisma.zoneList.create({ data, select: zoneListSelect });
}

export function updateList(id: string, data: Prisma.ZoneListUpdateInput): Promise<ZoneListRow> {
  return prisma.zoneList.update({ where: { id }, data, select: zoneListSelect });
}

export function deleteList(id: string) {
  return prisma.zoneList.delete({ where: { id }, select: { id: true } });
}

/** A list priced by a rate card cannot be deleted — the prices would lose their map. */
export function countCardsUsing(zoneListId: string): Promise<number> {
  return prisma.rateCard.count({ where: { zoneListId } });
}

/* ------------------------------------------------------------------ zones */

export function listZones(zoneListId: string, includeInactive: boolean): Promise<ZoneRow[]> {
  return prisma.zone.findMany({
    where: { zoneListId, ...(includeInactive ? {} : { active: true }) },
    select: zoneSelect,
    orderBy: { name: 'asc' },
  });
}

export function findZoneById(zoneId: string): Promise<ZoneRow | null> {
  return prisma.zone.findUnique({ where: { id: zoneId }, select: zoneSelect });
}

export function findZoneByName(zoneListId: string, name: string) {
  return prisma.zone.findFirst({
    where: { zoneListId, name: { equals: name, mode: 'insensitive' } },
    select: { id: true, name: true },
  });
}

export function createZone(data: {
  zoneListId: string;
  name: string;
  shortName?: string;
}): Promise<ZoneRow> {
  return prisma.zone.create({ data, select: zoneSelect });
}

export function updateZone(zoneId: string, data: Prisma.ZoneUpdateInput): Promise<ZoneRow> {
  return prisma.zone.update({ where: { id: zoneId }, data, select: zoneSelect });
}

/** Is this zone named on any route rate? If so it is deactivated, never deleted. */
export function countRatesUsing(zoneId: string): Promise<number> {
  return prisma.routeRate.count({
    where: { toZoneId: zoneId },
  });
}

export function deleteZone(zoneId: string) {
  return prisma.zone.delete({ where: { id: zoneId }, select: { id: true } });
}

/* ------------------------------------------------------------------ codes */

export function listCodes(zoneId: string): Promise<CodeRow[]> {
  return prisma.zonePostalRule.findMany({
    where: { zoneId },
    select: codeSelect,
    orderBy: [{ code: 'asc' }],
  });
}

/**
 * Codes from this list that already belong to a DIFFERENT zone.
 *
 * This is the whole of the conflict rule: one code, one zone, per list. The
 * unique index on (zoneListId, code) is the real guard; this query exists so the
 * operator is told which zone took it rather than reading a constraint name.
 */
export function findConflicts(zoneListId: string, codes: string[], exceptZoneId: string) {
  if (codes.length === 0) return Promise.resolve([]);
  return prisma.zonePostalRule.findMany({
    where: { zoneListId, code: { in: codes }, zoneId: { not: exceptZoneId } },
    select: { code: true, zone: { select: { id: true, name: true } } },
    orderBy: { code: 'asc' },
  });
}

/**
 * Replace this zone's TYPED codes with exactly this set, in one transaction.
 *
 * Codes drawn from the map are left alone, so typing in the box can never undo a
 * drawing and redrawing can never undo the box. Each source owns its own rows.
 */
export function replaceTypedCodes(
  zoneId: string,
  zoneListId: string,
  codes: Array<{ code: string; type: PostalCodeType }>,
): Promise<CodeRow[]> {
  return prisma.$transaction(async (tx) => {
    await tx.zonePostalRule.deleteMany({ where: { zoneId, source: 'TYPED' } });

    if (codes.length > 0) {
      await tx.zonePostalRule.createMany({
        data: codes.map((c) => ({
          zoneId,
          zoneListId,
          code: c.code,
          codeType: c.type,
          source: 'TYPED' as const,
        })),
        // A code already held by this same zone from the map stays as it is.
        skipDuplicates: true,
      });
    }

    return tx.zonePostalRule.findMany({
      where: { zoneId },
      select: codeSelect,
      orderBy: [{ code: 'asc' }],
    });
  });
}

export function deleteCode(zoneId: string, code: string) {
  return prisma.zonePostalRule.deleteMany({ where: { zoneId, code } });
}

/**
 * Replace this zone's MAP codes with exactly this set. The mirror image of
 * `replaceTypedCodes`: redrawing replaces everything the last drawing produced
 * and leaves every typed code alone.
 */
export function replaceMapCodes(
  zoneId: string,
  zoneListId: string,
  codes: Array<{ code: string; type: PostalCodeType }>,
): Promise<CodeRow[]> {
  return prisma.$transaction(async (tx) => {
    await tx.zonePostalRule.deleteMany({ where: { zoneId, source: 'MAP' } });

    if (codes.length > 0) {
      await tx.zonePostalRule.createMany({
        data: codes.map((c) => ({
          zoneId,
          zoneListId,
          code: c.code,
          codeType: c.type,
          source: 'MAP' as const,
        })),
        // A code this zone already holds from the typed box wins; it stays TYPED.
        skipDuplicates: true,
      });
    }

    return tx.zonePostalRule.findMany({
      where: { zoneId },
      select: codeSelect,
      orderBy: [{ code: 'asc' }],
    });
  });
}

/* ----------------------------------------------------------------- shapes */

export function findShape(zoneId: string) {
  return prisma.zoneMapShape.findUnique({
    where: { zoneId },
    select: { geojson: true, updatedAt: true },
  });
}

export function upsertShape(zoneId: string, geojson: Prisma.InputJsonValue) {
  return prisma.zoneMapShape.upsert({
    where: { zoneId },
    create: { zoneId, geojson },
    update: { geojson },
    select: { geojson: true, updatedAt: true },
  });
}

export function deleteShape(zoneId: string) {
  return prisma.zoneMapShape.deleteMany({ where: { zoneId } });
}

/** Is the StatCan boundary table loaded at all? */
export async function boundaryCount(): Promise<number> {
  const [row] = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*)::bigint AS n FROM fsa_boundaries
  `;
  return Number(row?.n ?? 0);
}

export interface FsaHit {
  code: string;
  /** The whole FSA lies inside the drawn shape. */
  fullyInside: boolean;
  /** How much of the FSA the shape covers, 0–100. */
  coveragePct: number;
  /**
   * Which drawn area caught it, numbered from 1 the way the console lists them.
   * Where two areas overlap an FSA, the one covering more of it owns the row —
   * a code has to appear under exactly one heading or the counts stop adding up.
   */
  part: number;
}

/**
 * Which FSAs a drawn polygon touches, and how completely.
 *
 * Raw SQL because PostGIS is not in the Prisma schema: `fsa_boundaries` is
 * reference data replaced wholesale from StatCan, not something the application
 * writes, and modelling it would put a geometry column Prisma cannot express in
 * the middle of the schema.
 *
 * Area is measured on the geography type, so a shape in northern Ontario is not
 * judged by a projection that stretches it.
 */
export async function fsasTouching(geojson: unknown): Promise<FsaHit[]> {
  const rows = await prisma.$queryRaw<
    Array<{ code: string; fully_inside: boolean; pct: number; part: number | null }>
  >`
    WITH poly AS (
      SELECT extensions.ST_MakeValid(
               extensions.ST_SetSRID(
                 extensions.ST_GeomFromGeoJSON(${JSON.stringify(geojson)}::text), 4326
               )
             ) AS g
    )
    ,
    -- One row per drawn area, numbered as the console lists them. A single
    -- polygon dumps to exactly one part, so nothing changes for the simple case.
    parts AS (
      SELECT (d).path[1]::int AS part, (d).geom AS g
      FROM poly, extensions.ST_Dump(poly.g) AS d
    )
    SELECT b.code,
           extensions.ST_CoveredBy(b.geom, poly.g) AS fully_inside,
           LEAST(100, GREATEST(0,
             extensions.ST_Area(extensions.ST_Intersection(b.geom, poly.g)::extensions.geography)
             / NULLIF(extensions.ST_Area(b.geom::extensions.geography), 0) * 100
           ))::double precision AS pct,
           (
             SELECT p.part
             FROM parts p
             WHERE extensions.ST_Intersects(b.geom, p.g)
             ORDER BY extensions.ST_Area(
                        extensions.ST_Intersection(b.geom, p.g)::extensions.geography
                      ) DESC
             LIMIT 1
           )::int AS part
    FROM fsa_boundaries b, poly
    WHERE extensions.ST_Intersects(b.geom, poly.g)
    ORDER BY b.code
  `;

  return rows.map((r) => ({
    code: r.code,
    fullyInside: r.fully_inside,
    coveragePct: Math.round((r.pct ?? 0) * 10) / 10,
    part: r.part ?? 1,
  }));
}

/**
 * Weld the drawn areas into a tidy shape: overlapping pieces become one piece.
 *
 * Two polygons laid over each other are not two areas, they are one oddly drawn
 * area, and leaving them apart makes the stored geometry invalid and double
 * counts whatever sits beneath the overlap. Always a MultiPolygon on the way
 * out, so the console can count areas the same way every time.
 */
export async function normaliseShape(geojson: unknown): Promise<unknown> {
  const rows = await prisma.$queryRaw<Array<{ g: string | null }>>`
    SELECT extensions.ST_AsGeoJSON(
             extensions.ST_Multi(
               -- Union BEFORE repair, not after: ST_MakeValid resolves overlapping
               -- parts by cutting them into disjoint pieces, which leaves the union
               -- nothing left to weld and quietly returns the two areas unchanged.
               extensions.ST_CollectionExtract(
                 extensions.ST_MakeValid(
                   extensions.ST_UnaryUnion(
                     extensions.ST_SetSRID(
                       extensions.ST_GeomFromGeoJSON(${JSON.stringify(geojson)}::text), 4326
                     )
                   )
                 ),
                 3
               )
             )
           ) AS g
  `;
  const out = rows[0]?.g;
  return out ? JSON.parse(out) : geojson;
}

/**
 * Every rule in this list that could match one address: the full code and the FSA
 * it sits inside. Inactive zones are excluded, so retiring a zone retires its
 * codes without deleting them.
 *
 * Which of the two wins is decided by the caller, because the rule — a full code
 * beats its own FSA — is policy, not a query.
 */
export function findMatchingRules(zoneListId: string, full: string, fsa: string) {
  return prisma.zonePostalRule.findMany({
    where: { zoneListId, code: { in: [full, fsa] }, zone: { active: true } },
    select: { code: true, codeType: true, zone: { select: { id: true, name: true } } },
  });
}
