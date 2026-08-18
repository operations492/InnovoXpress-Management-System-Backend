import { ConsignmentStatus } from '@prisma/client';
import * as repo from './drivers.repository.js';
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
  return { ...row, nextAction: NEXT_ACTION[row.status] ?? 'NONE' };
}

/**
 * `driverId` must come from the token, never from a query parameter — otherwise
 * a driver reads someone else's run by editing the URL.
 *
 * Delivered jobs are excluded by default: the driver's screen should show what
 * is left to do, not a growing history.
 */
export async function myConsignments(driverId: string, includeDelivered = false) {
  const rows = await repo.findConsignmentsForDriver(driverId, includeDelivered);
  return { data: rows.map(withNextAction) };
}
