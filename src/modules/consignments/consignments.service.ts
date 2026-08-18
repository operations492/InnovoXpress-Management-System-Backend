import type { Prisma } from '@prisma/client';
import { ConsignmentStatus } from '@prisma/client';
import { AppError } from '../../utils/httpError.js';
import { buildPageMeta, paginate } from '../../utils/pagination.js';
import { STATUS_LABELS } from '../../constants/enums.js';
import { canTransition, isEditable } from '../../constants/statusFlow.js';
import type { AssignDriverInput } from '../../schemas/assignment.schema.js';
import type { BulkAssignInput } from '../../schemas/bulkAssign.schema.js';
import type {
  ChangeStatusInput,
  CreateConsignmentInput,
  ItemInput,
  UpdateConsignmentInput,
} from '../../schemas/consignment.schema.js';
import type { ListConsignmentsQuery } from '../../schemas/query.schema.js';
import * as repo from './consignments.repository.js';

export interface Actor {
  id: string;
  email: string;
}

// ---------------------------------------------------------------------------
// mapping helpers
// ---------------------------------------------------------------------------

function num(d: Prisma.Decimal | null): number | null {
  return d === null ? null : Number(d);
}

function senderColumns(s: CreateConsignmentInput['sender']) {
  return {
    senderName: s.name,
    senderPhone: s.phone ?? null,
    senderEmail: s.email ?? null,
    senderLine1: s.line1,
    senderArea: s.area ?? null,
    senderCity: s.city,
    senderPostcode: s.postcode ?? null,
    senderInstructions: s.instructions ?? null,
    senderLat: s.lat ?? null,
    senderLng: s.lng ?? null,
  };
}

function receiverColumns(r: CreateConsignmentInput['receiver']) {
  return {
    receiverName: r.name,
    receiverPhone: r.phone ?? null,
    receiverEmail: r.email ?? null,
    receiverLine1: r.line1,
    receiverArea: r.area ?? null,
    receiverCity: r.city,
    receiverPostcode: r.postcode ?? null,
    receiverNotes: r.notes ?? null,
    receiverLat: r.lat ?? null,
    receiverLng: r.lng ?? null,
  };
}

function itemColumns(i: ItemInput) {
  return {
    description: i.description,
    qty: i.qty,
    weightKg: i.weightKg ?? null,
    packageType: i.packageType ?? null,
    barcode: i.barcode ?? null,
  };
}

/**
 * `weightKg` is the weight of the whole line, not a per-unit weight, so the
 * order total is a plain sum and is NOT multiplied by qty.
 */
function totalsOf(items: Array<{ qty: number; weightKg: Prisma.Decimal | null }>) {
  return {
    itemCount: items.length,
    totalQty: items.reduce((sum, i) => sum + i.qty, 0),
    totalWeightKg: Number(
      items.reduce((sum, i) => sum + (i.weightKg === null ? 0 : Number(i.weightKg)), 0).toFixed(3),
    ),
  };
}

function toSummary(row: repo.SummaryRow) {
  return {
    id: row.id,
    orderNo: row.orderNo,
    clientReference: row.clientReference,
    client: row.client,
    driver: row.driver,
    status: row.status,
    statusLabel: STATUS_LABELS[row.status],
    priority: row.priority,
    taskType: row.taskType,
    senderName: row.senderName,
    senderLine1: row.senderLine1,
    senderCity: row.senderCity,
    senderArea: row.senderArea,
    senderLat: row.senderLat,
    senderLng: row.senderLng,
    receiverName: row.receiverName,
    receiverLine1: row.receiverLine1,
    receiverCity: row.receiverCity,
    receiverArea: row.receiverArea,
    receiverLat: row.receiverLat,
    receiverLng: row.receiverLng,
    readyBy: row.readyBy,
    deliverBy: row.deliverBy,
    generalNote: row.generalNote,
    createdAt: row.createdAt,
    ...totalsOf(row.items),
  };
}

function toDetail(c: repo.FullConsignment) {
  return {
    id: c.id,
    orderNo: c.orderNo,
    clientReference: c.clientReference,
    client: c.client,
    driver: c.driver,
    status: c.status,
    statusLabel: STATUS_LABELS[c.status],
    priority: c.priority,
    taskType: c.taskType,
    sender: {
      name: c.senderName,
      phone: c.senderPhone,
      email: c.senderEmail,
      line1: c.senderLine1,
      area: c.senderArea,
      city: c.senderCity,
      postcode: c.senderPostcode,
      instructions: c.senderInstructions,
      lat: c.senderLat,
      lng: c.senderLng,
    },
    receiver: {
      name: c.receiverName,
      phone: c.receiverPhone,
      email: c.receiverEmail,
      line1: c.receiverLine1,
      area: c.receiverArea,
      city: c.receiverCity,
      postcode: c.receiverPostcode,
      notes: c.receiverNotes,
      lat: c.receiverLat,
      lng: c.receiverLng,
    },
    readyBy: c.readyBy,
    deliverBy: c.deliverBy,
    assignedAt: c.assignedAt,
    pickedUpAt: c.pickedUpAt,
    deliveredAt: c.deliveredAt,
    generalNote: c.generalNote,
    items: c.items.map((i) => ({
      id: i.id,
      description: i.description,
      qty: i.qty,
      weightKg: num(i.weightKg),
      packageType: i.packageType,
      barcode: i.barcode,
    })),
    totals: totalsOf(c.items),
    proofs: c.proofs.map((p) => ({
      leg: p.leg,
      capturedAt: p.capturedAt,
      photoBytes: p.photoBytes,
      signatureBytes: p.signatureBytes,
    })),
    timeline: c.trackingEvents.map((e) => ({
      id: e.id,
      fromStatus: e.fromStatus,
      toStatus: e.toStatus,
      fromStatusLabel: e.fromStatus ? STATUS_LABELS[e.fromStatus] : null,
      toStatusLabel: STATUS_LABELS[e.toStatus],
      driver: e.driver,
      actorEmail: e.actorEmail,
      note: e.note,
      recordedAt: e.recordedAt,
    })),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// operations
// ---------------------------------------------------------------------------

export async function createConsignment(input: CreateConsignmentInput, actor: Actor) {
  const client = await repo.findClientById(input.clientId);
  if (!client) throw AppError.badRequest('Unknown client');
  if (!client.active) throw AppError.badRequest(`Client "${client.name}" is inactive`);

  // Pre-check for a readable message; the composite unique index is the real guard.
  if (input.clientReference) {
    const taken = await repo.clientReferenceTaken(client.id, input.clientReference);
    if (taken) {
      throw AppError.conflict(
        `Reference "${input.clientReference}" is already used by another ${client.name} order`,
      );
    }
  }

  // Allocated before the insert, and deliberately NOT inside it. The counter row
  // is a serialization point for every create of this client on this day, so the
  // lock must be held for one statement rather than for a whole multi-statement
  // transaction — otherwise concurrent creates queue behind each other and, on a
  // cross-region connection, blow the transaction timeout.
  //
  // The trade-off is that a failed insert burns a number, leaving a gap in the
  // sequence. That is fine here: order numbers are identifiers, not a gapless
  // financial series.
  const orderNo = await repo.allocateOrderNo(client.id, client.code);

  const created = await repo.createConsignment({
      orderNo,
      clientReference: input.clientReference ?? null,
      client: { connect: { id: client.id } },
      status: ConsignmentStatus.UNASSIGNED,
      priority: input.priority,
      taskType: input.taskType,
      ...senderColumns(input.sender),
      ...receiverColumns(input.receiver),
      readyBy: input.readyBy ?? null,
      deliverBy: input.deliverBy ?? null,
      generalNote: input.generalNote ?? null,
      createdByUserId: actor.id,
      lastUpdatedByUserId: actor.id,
      items: { create: input.items.map(itemColumns) },
      trackingEvents: {
        create: {
          fromStatus: null,
          toStatus: ConsignmentStatus.UNASSIGNED,
          actorUserId: actor.id,
          actorEmail: actor.email,
          note: 'Consignment logged',
        },
      },
  });

  return getConsignment(created.id);
}

export async function getConsignment(id: string) {
  const found = await repo.findFullById(id);
  if (!found) throw AppError.notFound('Consignment not found');
  return toDetail(found);
}

export async function listConsignments(query: ListConsignmentsQuery) {
  const where = repo.buildWhere(query);
  const { skip, take } = paginate(query.page, query.pageSize);
  const orderBy = { [query.sort]: query.order } as Prisma.ConsignmentOrderByWithRelationInput;

  const [rows, total] = await Promise.all([
    repo.listSummaries(where, orderBy, skip, take),
    repo.countWhere(where),
  ]);

  return {
    data: rows.map(toSummary),
    meta: buildPageMeta(total, query.page, query.pageSize),
  };
}

/**
 * Move the order along one manual step.
 *
 * Only the four "travelling / arrived" transitions come through here. The schema
 * refuses any other target, and `canTransition(..., 'MANUAL')` refuses it again
 * in case the schema is ever widened — PICKED_UP and DELIVERED must stay
 * reachable only by capturing proof.
 */
export async function changeStatus(
  consignmentId: string,
  input: ChangeStatusInput,
  actor: Actor,
) {
  const existing = await repo.findForUpdate(consignmentId);
  if (!existing) throw AppError.notFound('Consignment not found');

  const target = input.status as ConsignmentStatus;

  if (!canTransition(existing.status, target, 'MANUAL')) {
    throw AppError.conflict(
      `Cannot move from ${STATUS_LABELS[existing.status]} to ${STATUS_LABELS[target]}`,
    );
  }

  await repo.changeStatusTx({
    id: consignmentId,
    expected: existing.status,
    next: target,
    actorId: actor.id,
    actorEmail: actor.email,
    driverId: existing.driverId,
    note: input.note ?? null,
    conflictMessage: 'The order changed while you were updating it, please retry',
  });

  return getConsignment(consignmentId);
}

/**
 * Attach a driver.
 *
 * Two shapes, both reached through this one call because a dispatcher thinks of
 * both as "set the driver":
 *   UNASSIGNED -> ASSIGNED   a fresh assignment; status moves, assignedAt stamped
 *   ASSIGNED   -> ASSIGNED   a swap before the run starts; status does not move
 *
 * Past ASSIGNED the driver is already on the road with the goods, so the crew on
 * a job stops being an editable field and becomes history.
 */
/**
 * Assign many orders to one driver.
 *
 * **Partial success is the contract, not a compromise.** Fifty orders selected on a
 * map are fifty independent decisions: one that has already been collected, or one
 * someone else grabbed a second ago, must not roll back the forty-nine that were
 * fine. An all-or-nothing transaction here would mean an operator repeatedly
 * deselecting one offender to get anything done.
 *
 * So each order goes through the SAME `assignDriver` path as a single assignment —
 * identical rules, identical tracking events, identical conflict handling — and its
 * failure is collected rather than thrown. The response then names every order that
 * did not make it and why, because "3 of 50 failed" is useless on its own.
 *
 * Sequential on purpose. Fifty parallel transactions against the same driver row
 * would serialise in the database anyway, and would make the failure report
 * non-deterministic.
 */
export async function assignDriverBulk(input: BulkAssignInput, actor: Actor) {
  const ids = [...new Set(input.consignmentIds)];

  // One lookup up front rather than one per failure: an operator picked these off a
  // map and needs order numbers back, not cuids.
  const known = await repo.findOrderNumbers(ids);
  const orderNoOf = new Map(known.map((c) => [c.id, c.orderNo]));

  const assigned: string[] = [];
  const failed: { id: string; orderNo: string | null; code: string; message: string }[] = [];

  for (const id of ids) {
    try {
      const updated = await assignDriver(id, { driverId: input.driverId, note: input.note }, actor);
      assigned.push(updated.id);
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      failed.push({
        id,
        orderNo: orderNoOf.get(id) ?? null,
        code: err.code,
        message: err.message,
      });
    }
  }

  return {
    driverId: input.driverId,
    assigned,
    failed,
    counts: { requested: ids.length, assigned: assigned.length, failed: failed.length },
  };
}

export async function assignDriver(
  consignmentId: string,
  input: AssignDriverInput,
  actor: Actor,
) {
  const existing = await repo.findForUpdate(consignmentId);
  if (!existing) throw AppError.notFound('Consignment not found');

  const driver = await repo.findDriverById(input.driverId);
  if (!driver) throw AppError.badRequest('Unknown driver');
  if (!driver.active) throw AppError.badRequest(`Driver "${driver.name}" is inactive`);

  /*
   * A driver who has not clocked on cannot be given work — they are not carrying
   * the app, so they will never see the job and dispatch cannot see where they are.
   *
   * This is the enforcement; the console greying out off-shift drivers is only
   * presentation, and anything talking to the API directly ignores it.
   *
   * A conflict rather than a bad request: the id is perfectly valid and the same
   * call succeeds the moment they clock on, which is exactly what 409 means. It
   * also applies to a swap — moving a job onto someone who went home is the same
   * mistake as assigning it there in the first place.
   *
   * Note this deliberately does NOT touch orders already assigned to a driver who
   * later clocks off. Work in progress must not evaporate at the end of a shift.
   */
  if (!driver.onShift) {
    throw AppError.conflict(
      `Driver "${driver.name}" is off shift — they must clock on before taking new work`,
    );
  }

  const isFreshAssignment = existing.status === ConsignmentStatus.UNASSIGNED;
  const isReassignment = existing.status === ConsignmentStatus.ASSIGNED;

  if (!isFreshAssignment && !isReassignment) {
    throw AppError.conflict(
      `The driver can no longer be changed once the order is ${STATUS_LABELS[existing.status]}`,
    );
  }

  if (isReassignment && existing.driverId === driver.id) {
    throw AppError.conflict(`Already assigned to ${driver.name}`);
  }

  if (isFreshAssignment && !canTransition(existing.status, ConsignmentStatus.ASSIGNED, 'ASSIGNMENT')) {
    throw AppError.conflict('That status change is not allowed');
  }

  const previousDriver = existing.driverId
    ? await repo.findDriverById(existing.driverId)
    : null;

  await repo.changeStatusTx({
    id: consignmentId,
    expected: existing.status,
    next: ConsignmentStatus.ASSIGNED,
    actorId: actor.id,
    actorEmail: actor.email,
    driverId: driver.id,
    extraData: {
      driverId: driver.id,
      ...(isFreshAssignment ? { assignedAt: new Date() } : {}),
    },
    note:
      input.note ??
      (previousDriver
        ? `Reassigned from ${previousDriver.name} to ${driver.name}`
        : `Assigned to ${driver.name}`),
    conflictMessage: 'The order changed while you were assigning it, please retry',
  });

  return getConsignment(consignmentId);
}

/** Detach the driver and return the order to the dispatcher's queue. */
export async function unassignDriver(consignmentId: string, actor: Actor) {
  const existing = await repo.findForUpdate(consignmentId);
  if (!existing) throw AppError.notFound('Consignment not found');

  if (existing.status !== ConsignmentStatus.ASSIGNED) {
    throw existing.status === ConsignmentStatus.UNASSIGNED
      ? AppError.conflict('No driver is assigned to this order')
      : AppError.conflict(
          `The driver cannot be removed once the order is ${STATUS_LABELS[existing.status]}`,
        );
  }

  const driver = existing.driverId ? await repo.findDriverById(existing.driverId) : null;

  await repo.changeStatusTx({
    id: consignmentId,
    expected: ConsignmentStatus.ASSIGNED,
    next: ConsignmentStatus.UNASSIGNED,
    actorId: actor.id,
    actorEmail: actor.email,
    driverId: existing.driverId,
    extraData: { driverId: null, assignedAt: null },
    note: driver ? `Unassigned from ${driver.name}` : 'Driver removed',
    conflictMessage: 'The order changed while you were unassigning it, please retry',
  });

  return getConsignment(consignmentId);
}

export async function updateConsignment(
  id: string,
  input: UpdateConsignmentInput,
  actor: Actor,
) {
  const existing = await repo.findForUpdate(id);
  if (!existing) throw AppError.notFound('Consignment not found');

  // Once a driver is en route the record is operational history, not a draft.
  if (!isEditable(existing.status)) {
    throw AppError.conflict(
      `A consignment in status ${STATUS_LABELS[existing.status]} can no longer be edited`,
    );
  }

  if (input.clientReference) {
    const taken = await repo.clientReferenceTaken(
      existing.clientId,
      input.clientReference,
      id,
    );
    if (taken) {
      throw AppError.conflict(
        `Reference "${input.clientReference}" is already used by another order of this client`,
      );
    }
  }

  const data: Prisma.ConsignmentUpdateInput = { lastUpdatedByUserId: actor.id };

  if (input.clientReference !== undefined) data.clientReference = input.clientReference;
  if (input.taskType !== undefined) data.taskType = input.taskType;
  if (input.priority !== undefined) data.priority = input.priority;
  if (input.readyBy !== undefined) data.readyBy = input.readyBy;
  if (input.deliverBy !== undefined) data.deliverBy = input.deliverBy;
  if (input.generalNote !== undefined) data.generalNote = input.generalNote;
  if (input.sender) Object.assign(data, senderColumns(input.sender));
  if (input.receiver) Object.assign(data, receiverColumns(input.receiver));

  await repo.updateConsignmentTx({
    id,
    data,
    items: input.items?.map((i) => ({ id: i.id, columns: itemColumns(i) })),
  });

  return getConsignment(id);
}
