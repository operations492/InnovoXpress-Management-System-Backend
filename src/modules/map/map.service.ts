import type { ConsignmentStatus } from '@prisma/client';
import * as repo from './map.repository.js';
import {
  MAP_COLOR_COUNT,
  MAP_TABS,
  MAP_TAB_STATUSES,
  type MapTab,
} from '../../constants/mapTabs.js';
import type { MapDriversQuery, MapPinsQuery } from '../../schemas/map.schema.js';

/*
 * Business rules for the dispatch map. Never imports prisma.
 *
 * Independent reads run through Promise.all rather than $transaction —
 * $transaction would require prisma here, and parallel round trips give the same
 * latency win without breaking the layer rule.
 */

/**
 * How far back "completed" reaches when the caller does not say.
 *
 * A rolling 24 hours, not "start of today", because the server cannot know the
 * operator's timezone — and the consignments repository already has a bug of
 * exactly that shape, where `inclusiveEnd()` reads server-local time. A client
 * that wants a real day boundary sends `completedSince` as an instant.
 */
const DEFAULT_COMPLETED_WINDOW_MS = 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* coordinates                                                         */
/* ------------------------------------------------------------------ */

/**
 * Whether a pair can actually be plotted.
 *
 * `(0, 0)` is rejected: it is a valid Float pair and a real place in the Gulf of
 * Guinea, so it is what an import bug looks like rather than a location in
 * Pakistan. The range check catches the other classic geocoding failure — a
 * swapped lat/lng, which otherwise renders as a pin in the wrong hemisphere
 * instead of an error.
 */
function plottable(lat: number | null, lng: number | null): boolean {
  if (lat === null || lng === null) return false;
  if (lat === 0 && lng === 0) return false;
  if (lat < -90 || lat > 90) return false;
  if (lng < -180 || lng > 180) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/* colour                                                              */
/* ------------------------------------------------------------------ */

/**
 * A stable slot for a driver who has no assigned colour yet.
 *
 * Only a fallback — the real value is `drivers.mapColorIndex`, assigned
 * least-used-first on create. This exists so a driver created before the
 * migration never renders colourless.
 */
function fallbackColorIndex(driverId: string): number {
  let hash = 0;
  for (let i = 0; i < driverId.length; i += 1) {
    hash = (hash * 31 + driverId.charCodeAt(i)) % 100_000_007;
  }
  return hash % MAP_COLOR_COUNT;
}

const colorOf = (driver: { id: string; mapColorIndex: number | null }) =>
  driver.mapColorIndex ?? fallbackColorIndex(driver.id);

/**
 * The palette slot a new driver should take: least used, lowest index on a tie.
 *
 * Beyond the palette this round-robins evenly rather than clumping. There is
 * deliberately no unique constraint — the ninth driver reuses a colour instead
 * of failing to be created.
 */
export async function nextColorIndex(): Promise<number> {
  const used = await repo.countDriversByColor();

  const tally = new Array<number>(MAP_COLOR_COUNT).fill(0);
  for (const row of used) {
    if (row.mapColorIndex === null) continue;
    if (row.mapColorIndex < 0 || row.mapColorIndex >= MAP_COLOR_COUNT) continue;
    tally[row.mapColorIndex] += row._count._all;
  }

  let best = 0;
  for (let i = 1; i < MAP_COLOR_COUNT; i += 1) {
    if (tally[i] < tally[best]) best = i;
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* dto                                                                 */
/* ------------------------------------------------------------------ */

function toPinDto(row: repo.PinRow, totalQty: number) {
  const canPlot = plottable(row.receiverLat, row.receiverLng);

  return {
    id: row.id,
    orderNo: row.orderNo,
    status: row.status,
    taskType: row.taskType,
    priority: row.priority,

    // The pin is the receiver, at every status, per the product decision.
    // Null rather than a guess when it cannot be plotted — see `unmappable`.
    lat: canPlot ? row.receiverLat : null,
    lng: canPlot ? row.receiverLng : null,

    // Both raw pairs ship regardless. Two floats, and it keeps "which end does
    // the pin show" a client decision rather than a backend release.
    senderLat: row.senderLat,
    senderLng: row.senderLng,
    receiverLat: row.receiverLat,
    receiverLng: row.receiverLng,

    // The click-widget, riding along.
    receiverName: row.receiverName,
    receiverLine1: row.receiverLine1,
    receiverArea: row.receiverArea,
    receiverCity: row.receiverCity,
    totalQty,
    readyBy: row.readyBy,
    deliverBy: row.deliverBy,

    driver: row.driver
      ? { id: row.driver.id, name: row.driver.name, colorIndex: colorOf(row.driver) }
      : null,
  };
}

/* ------------------------------------------------------------------ */
/* counts                                                              */
/* ------------------------------------------------------------------ */

type StatusTally = Record<string, number>;

function tallyOf(rows: Array<{ status: ConsignmentStatus; _count: { _all: number } }>): StatusTally {
  const tally: StatusTally = {};
  for (const row of rows) tally[row.status] = row._count._all;
  return tally;
}

/** Tab badges are sums of status buckets, so they always add up to the total. */
function tabCounts(tally: StatusTally): Record<MapTab, number> {
  const counts = {} as Record<MapTab, number>;
  for (const tab of MAP_TABS) {
    counts[tab] = MAP_TAB_STATUSES[tab].reduce((sum, status) => sum + (tally[status] ?? 0), 0);
  }
  return counts;
}

/* ------------------------------------------------------------------ */
/* pins                                                               */
/* ------------------------------------------------------------------ */

export async function pins(query: MapPinsQuery) {
  const filters: repo.PinFilters = {
    tab: query.tab as MapTab | undefined,
    driverIds: query.driverIds,
    clientId: query.clientId,
    q: query.q,
    from: query.from,
    to: query.to,
    completedSince:
      query.completedSince ?? new Date(Date.now() - DEFAULT_COMPLETED_WINDOW_MS),
  };

  const rowsWhere = repo.buildPinWhere(filters);
  // Counts respect every filter EXCEPT the tab, so the badges do not change as
  // the operator switches between them.
  const countsWhere = repo.buildPinWhere(repo.withoutTab(filters));

  const [rows, statusRows, driverRows] = await Promise.all([
    repo.findPins(rowsWhere, query.limit),
    repo.countByStatus(countsWhere),
    repo.countByDriver(countsWhere),
  ]);

  // Depends on which rows came back, so it cannot be parallelised with them.
  const qtyRows = await repo.sumQtyByConsignment(rows.map((r) => r.id));
  const qtyById = new Map(qtyRows.map((r) => [r.consignmentId, r._sum.qty ?? 0]));

  const tally = tallyOf(statusRows);
  const counts = tabCounts(tally);
  const total = Object.values(tally).reduce((sum, n) => sum + n, 0);

  const data = rows.map((row) => toPinDto(row, qtyById.get(row.id) ?? 0));

  // How many rows the current filters SHOULD have produced.
  const expected = filters.tab ? counts[filters.tab] : total;

  const byDriver: Record<string, number> = {};
  for (const row of driverRows) {
    if (row.driverId) byDriver[row.driverId] = row._count._all;
  }

  return {
    data,
    meta: {
      counts,
      byStatus: tally,
      byDriver,
      /**
       * Tasks with no usable coordinate. Returned in `data` with a null lat/lng
       * rather than dropped: they are real work, and a task with a broken
       * address is the one most likely to need attention. Silently hiding them
       * is the exact failure this count exists to prevent.
       */
      unmappable: data.filter((d) => d.lat === null).length,
      total,
      returned: data.length,
      /**
       * The limit is a circuit breaker, not a page size. If this is ever true
       * the UI must say so loudly — a dispatcher assigning work against a map
       * that is quietly missing tasks is worse than an error.
       */
      truncated: expected > data.length,
    },
  };
}

/* ------------------------------------------------------------------ */
/* drivers                                                             */
/* ------------------------------------------------------------------ */

export async function drivers(query: MapDriversQuery) {
  // Counted over the map's own default window, so the sidebar figure and the
  // number of pins on screen agree.
  const countsWhere = repo.buildPinWhere({
    completedSince: new Date(Date.now() - DEFAULT_COMPLETED_WINDOW_MS),
  });

  const [roster, driverRows] = await Promise.all([
    repo.findRoster(query.includeInactive === 'true'),
    repo.countByDriver(countsWhere),
  ]);

  const counts = new Map<string, number>();
  for (const row of driverRows) {
    if (row.driverId) counts.set(row.driverId, row._count._all);
  }

  // Left-merged onto the roster: groupBy only returns drivers who have rows, and
  // a driver with nothing to do must still appear — they are precisely the one a
  // dispatcher is looking for.
  return {
    data: roster.map((d) => ({
      id: d.id,
      name: d.name,
      code: d.code,
      active: d.active,
      onShift: d.onShift,
      colorIndex: colorOf(d),
      assignedCount: counts.get(d.id) ?? 0,
    })),
  };
}
