import { ConsignmentStatus } from '@prisma/client';

/**
 * Which mechanism is allowed to traverse an edge.
 *
 * - ASSIGNMENT — attaching/detaching a driver (Feature 2)
 * - MANUAL     — an operator/driver moving the job along (Feature 4)
 * - POD        — completed only by uploading proof of delivery (Feature 3)
 *
 * Gating edges (rather than just listing legal targets) is what makes it
 * impossible for the generic status endpoint to mark goods collected or
 * delivered without proof.
 */
export type Gate = 'ASSIGNMENT' | 'MANUAL' | 'POD';

export const TRANSITIONS: Record<
  ConsignmentStatus,
  Partial<Record<ConsignmentStatus, Gate>>
> = {
  UNASSIGNED: {
    ASSIGNED: 'ASSIGNMENT',
  },
  ASSIGNED: {
    UNASSIGNED: 'ASSIGNMENT',
    EN_ROUTE_TO_PICKUP: 'MANUAL',
  },
  EN_ROUTE_TO_PICKUP: {
    AT_PICKUP: 'MANUAL',
  },
  AT_PICKUP: {
    PICKED_UP: 'POD', // pickup leg only
  },
  PICKED_UP: {
    EN_ROUTE_TO_DELIVERY: 'MANUAL',
  },
  EN_ROUTE_TO_DELIVERY: {
    AT_DELIVERY: 'MANUAL',
  },
  AT_DELIVERY: {
    DELIVERED: 'POD', // delivery leg only
  },
  DELIVERED: {}, // terminal
};

/** True only if `from -> to` exists AND is traversable by this mechanism. */
export function canTransition(
  from: ConsignmentStatus,
  to: ConsignmentStatus,
  via: Gate,
): boolean {
  return TRANSITIONS[from]?.[to] === via;
}

/** The gate guarding `from -> to`, or undefined if the edge does not exist. */
export function gateFor(
  from: ConsignmentStatus,
  to: ConsignmentStatus,
): Gate | undefined {
  return TRANSITIONS[from]?.[to];
}

/**
 * Targets a plain status change may set. PICKED_UP / DELIVERED are absent by
 * construction (POD-gated) and so are ASSIGNED / UNASSIGNED (assignment-gated).
 */
export const MANUAL_STATUS_TARGETS = [
  ConsignmentStatus.EN_ROUTE_TO_PICKUP,
  ConsignmentStatus.AT_PICKUP,
  ConsignmentStatus.EN_ROUTE_TO_DELIVERY,
  ConsignmentStatus.AT_DELIVERY,
] as const;

/** An order may still be edited while it has not physically moved. */
export const EDITABLE_STATUSES: ConsignmentStatus[] = [
  ConsignmentStatus.UNASSIGNED,
  ConsignmentStatus.ASSIGNED,
];

export const TERMINAL_STATUSES: ConsignmentStatus[] = [ConsignmentStatus.DELIVERED];

export function isEditable(status: ConsignmentStatus): boolean {
  return EDITABLE_STATUSES.includes(status);
}
