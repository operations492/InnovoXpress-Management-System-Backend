import { ConsignmentStatus } from '@prisma/client';
import * as repo from './drivers.repository.js';
import { buildPageMeta, paginate } from '../../utils/pagination.js';
import type { DriverConsignmentRow } from './drivers.repository.js';

/**
 * What one driver has to do today.
 *
 * Kept apart from the console roster: this serves the driver's phone, not the
 * dispatcher's grid, and the two will diverge as the driver app grows.
 */

/**
 * The single next step for a job, so the driver app does not have to encode the
 * state machine a second time and drift from the server's version.
 *
 * The two CAPTURE_ steps are the POD-gated transitions — the app should open the
 * camera there, not offer a status button.
 */
const NEXT_ACTION: Record<ConsignmentStatus, string> = {
  [ConsignmentStatus.UNASSIGNED]: 'NONE',
  [ConsignmentStatus.ASSIGNED]: 'START_PICKUP',
  [ConsignmentStatus.EN_ROUTE_TO_PICKUP]: 'ARRIVE_AT_PICKUP',
  [ConsignmentStatus.AT_PICKUP]: 'CAPTURE_PICKUP_PROOF',
  [ConsignmentStatus.PICKED_UP]: 'START_DELIVERY',
  [ConsignmentStatus.EN_ROUTE_TO_DELIVERY]: 'ARRIVE_AT_DELIVERY',
  [ConsignmentStatus.AT_DELIVERY]: 'CAPTURE_DELIVERY_PROOF',
  [ConsignmentStatus.DELIVERED]: 'NONE',
};

function withNextAction(row: DriverConsignmentRow) {
  /*
   * Only the KINDS leave the API, never a storage path - the driver fetches the
   * files through /api/consignments/:id/documents, which mints signed links and
   * filters to the stop they are standing at.
   *
   * `hasReleaseLetter` is kept because the deployed app reads it; `documentKinds`
   * is what a new build should use, since there are two kinds now.
   */
  const { documents, ...rest } = row;
  return {
    ...rest,
    hasReleaseLetter: documents.some((d) => d.kind === 'RELEASE_LETTER'),
    documentKinds: documents.map((d) => d.kind),
    nextAction: NEXT_ACTION[row.status] ?? 'NONE',
  };
}

/**
 * `driverId` must come from the token, never from a query parameter — otherwise
 * a driver reads someone else's run by editing the URL.
 *
 * Delivered jobs are excluded by default: the driver's screen should show what
 * is left to do, not a growing history.
 */
export interface MyConsignmentsQuery {
  /** Newer and more precise than `includeDelivered`; when present it decides alone. */
  scope?: 'live' | 'delivered';
  includeDelivered?: boolean;
  page?: number;
  pageSize?: number;
}

/**
 * A driver's own work, whole or by the page.
 *
 * Paging is opt-in, and the response shape follows suit: ask without `page` and
 * you get `{ data }` exactly as before, so every existing caller is untouched.
 * Ask with it and `meta` comes too.
 *
 * `meta.total` is the point of the whole exercise. It lets a client label a tab
 * "Completed 437" while holding only the first twenty rows — without it, showing
 * a count would mean downloading everything, which is the cost paging exists to
 * remove.
 */
export async function myConsignments(driverId: string, query: MyConsignmentsQuery = {}) {
  const scope: repo.DriverScope =
    query.scope ?? (query.includeDelivered ? 'all' : 'live');

  if (query.page === undefined) {
    const rows = await repo.findConsignmentsForDriver(driverId, scope);
    return { data: rows.map(withNextAction) };
  }

  const page = query.page;
  const pageSize = query.pageSize ?? 20;

  /*
   * Count and page together, not in sequence. They are independent reads and
   * the round trip is the expensive part on a mobile connection — serialising
   * them would double the wait for no benefit.
   */
  const [rows, total] = await Promise.all([
    repo.findConsignmentsForDriver(driverId, scope, paginate(page, pageSize)),
    repo.countConsignmentsForDriver(driverId, scope),
  ]);

  return { data: rows.map(withNextAction), meta: buildPageMeta(total, page, pageSize) };
}
