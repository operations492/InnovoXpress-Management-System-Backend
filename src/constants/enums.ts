import {
  ConsignmentStatus,
  PackageType,
  PodLeg,
  Priority,
  TaskType,
  UserRole,
} from '@prisma/client';

export { ConsignmentStatus, PackageType, PodLeg, Priority, TaskType, UserRole };

export const STATUS_LABELS: Record<ConsignmentStatus, string> = {
  UNASSIGNED: 'Unassigned',
  ASSIGNED: 'Assigned',
  EN_ROUTE_TO_PICKUP: 'En Route to Pickup',
  AT_PICKUP: 'At Pickup',
  PICKED_UP: 'Picked Up',
  EN_ROUTE_TO_DELIVERY: 'En Route to Delivery',
  AT_DELIVERY: 'At Delivery',
  DELIVERED: 'Delivered',
};

export const PACKAGE_TYPE_LABELS: Record<PackageType, string> = {
  BOX: 'Box',
  BOTTLE: 'Bottle',
  ENVELOPE: 'Envelope',
  PALLET: 'Pallet',
  OTHER: 'Other',
};

export const PRIORITY_LABELS: Record<Priority, string> = {
  NORMAL: 'Normal',
  HIGH: 'High',
  LOW: 'Low',
};

export const TASK_TYPE_LABELS: Record<TaskType, string> = {
  DELIVERY: 'Delivery',
  PICKUP: 'Pickup',
  PICKUP_AND_DELIVERY: 'Pickup & Delivery',
};

export const POD_LEG_LABELS: Record<PodLeg, string> = {
  PICKUP: 'Pickup',
  DELIVERY: 'Delivery',
};

/** Turn a label map into `[{ value, label }]` for a frontend dropdown. */
export function asOptions<T extends string>(labels: Record<T, string>) {
  return (Object.keys(labels) as T[]).map((value) => ({ value, label: labels[value] }));
}
