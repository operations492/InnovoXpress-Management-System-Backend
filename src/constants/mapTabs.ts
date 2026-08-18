import { ConsignmentStatus } from '@prisma/client';

/**
 * The dispatch map's three sidebar tabs, as sets of lifecycle statuses.
 *
 * `constraints.sql` enforces `("driverId" IS NULL) = (status = 'UNASSIGNED')` —
 * a biconditional — so "has a driver" and "is unassigned" are the same fact.
 * That makes the three tabs a clean PARTITION of the eight-value enum, which is
 * why the badge counts can come from one groupBy and why they always sum to the
 * total. Filtering on `driverId` as well would be redundant at best and, if the
 * two ever disagreed, a source of counts that do not add up.
 *
 * Matches the product rule: a task stays in "Assigned" for as long as it has a
 * driver attached, whatever its status, until it is delivered.
 *
 * ⚠️ This is the single source of truth. Both the row filter and the count
 * derivation read it. If a second copy appears they will drift, and the symptom
 * is a badge reading 12 above a list of 11.
 */
export const MAP_TAB_STATUSES = {
  unassigned: [ConsignmentStatus.UNASSIGNED],
  assigned: [
    ConsignmentStatus.ASSIGNED,
    ConsignmentStatus.EN_ROUTE_TO_PICKUP,
    ConsignmentStatus.AT_PICKUP,
    ConsignmentStatus.PICKED_UP,
    ConsignmentStatus.EN_ROUTE_TO_DELIVERY,
    ConsignmentStatus.AT_DELIVERY,
  ],
  completed: [ConsignmentStatus.DELIVERED],
} as const satisfies Record<string, readonly ConsignmentStatus[]>;

export type MapTab = keyof typeof MAP_TAB_STATUSES;

export const MAP_TABS = Object.keys(MAP_TAB_STATUSES) as MapTab[];

/** Which tab a status belongs to — the inverse of the map above. */
export function tabOfStatus(status: ConsignmentStatus): MapTab {
  for (const tab of MAP_TABS) {
    if ((MAP_TAB_STATUSES[tab] as readonly ConsignmentStatus[]).includes(status)) return tab;
  }
  // Unreachable while the partition is total. If a ninth status is ever added
  // to the enum without being placed in a tab, failing loudly here is far
  // better than a badge that silently undercounts.
  throw new Error(`Status ${status} belongs to no map tab`);
}

/**
 * How many distinct colours the dispatch map can tell apart.
 *
 * Eight hues cannot distinguish thirty drivers, so colour is never the only
 * encoding — the pin also carries initials and the roster shows a swatch beside
 * the name. Driver number nine reuses a colour by design; see the least-used
 * assignment in the drivers module.
 */
export const MAP_COLOR_COUNT = 8;
