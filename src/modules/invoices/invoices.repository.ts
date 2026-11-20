import type { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma.js';

/* ------------------------------------------------------------- settings */

/**
 * The single settings row, created on first read.
 *
 * `invoices.sql` seeds it, but an environment restored from an older dump
 * would not have it, and a missing settings row should not be the reason an
 * invoice cannot be raised.
 */
export async function getSettings() {
  return prisma.financeSetting.upsert({
    where: { id: 'default' },
    update: {},
    create: { id: 'default' },
  });
}

export function updateSettings(data: Prisma.FinanceSettingUpdateInput) {
  return prisma.financeSetting.update({ where: { id: 'default' }, data });
}

/**
 * Take the next invoice number.
 *
 * One atomic `increment`, taken **outside** any transaction, exactly as order
 * numbers are allocated. Holding the row lock across a whole transaction makes
 * concurrent creates queue and then time out. A failed insert burns a number;
 * gaps in an invoice series are ordinary and auditors expect them.
 */
export async function nextInvoiceNumber(): Promise<string> {
  const row = await prisma.financeSetting.upsert({
    where: { id: 'default' },
    update: { invoiceNextNumber: { increment: 1 } },
    create: { id: 'default', invoiceNextNumber: 1001 },
    select: { invoicePrefix: true, invoiceNextNumber: true },
  });
  // The row now holds the NEXT number, so the one we just claimed is one less.
  return `${row.invoicePrefix}${row.invoiceNextNumber - 1}`;
}

/* ------------------------------------------------------------- selects */

export const invoiceListSelect = {
  id: true,
  number: true,
  invoiceDate: true,
  dueDate: true,
  status: true,
  currency: true,
  taxPct: true,
  baseTotal: true,
  serviceTotal: true,
  levyTotal: true,
  taxTotal: true,
  grandTotal: true,
  notes: true,
  createdAt: true,
  approvedAt: true,
  client: {
    select: {
      id: true,
      name: true,
      code: true,
      taxExempt: true,
      // Pre-fills the To box when the invoice is emailed.
      email: true,
      // The printed bill-to block. Taken live rather than snapshotted: an
      // address correction should show on a reprint, unlike the money.
      line1: true,
      city: true,
      province: true,
      postcode: true,
    },
  },
  createdBy: { select: { id: true, email: true } },
  approvedBy: { select: { id: true, email: true } },
  _count: { select: { lines: true } },
} satisfies Prisma.InvoiceSelect;

const lineSelect = {
  id: true,
  levyPct: true,
  distanceKm: true,
  waitMinutes: true,
  baseAmount: true,
  serviceAmount: true,
  levyAmount: true,
  taxAmount: true,
  grandTotal: true,
  ratingNotes: true,
  edited: true,
  rateCardId: true,
  priceLines: {
    orderBy: { sortOrder: 'asc' },
    select: {
      id: true,
      kind: true,
      key: true,
      label: true,
      detail: true,
      amount: true,
      sortOrder: true,
      editable: true,
    },
  },
  consignment: {
    select: {
      id: true,
      orderNo: true,
      clientReference: true,
      status: true,
      deliveredAt: true,
      pickedUpAt: true,
      createdAt: true,
      senderName: true,
      senderLine1: true,
      senderCity: true,
      senderProvince: true,
      senderPostcode: true,
      receiverName: true,
      receiverLine1: true,
      receiverCity: true,
      receiverProvince: true,
      receiverPostcode: true,
      items: { select: { qty: true, description: true, weightLb: true } },
    },
  },
} satisfies Prisma.InvoiceLineSelect;

export const invoiceDetailSelect = {
  ...invoiceListSelect,
  lines: { orderBy: { createdAt: 'asc' }, select: lineSelect },
  sends: {
    orderBy: { sentAt: 'desc' },
    select: {
      id: true,
      toEmails: true,
      ccEmails: true,
      sentAt: true,
      sentBy: { select: { email: true } },
    },
  },
} satisfies Prisma.InvoiceSelect;

export type InvoiceListRow = Prisma.InvoiceGetPayload<{ select: typeof invoiceListSelect }>;
export type InvoiceDetailRow = Prisma.InvoiceGetPayload<{ select: typeof invoiceDetailSelect }>;
export type InvoiceLineRow = Prisma.InvoiceLineGetPayload<{ select: typeof lineSelect }>;

/* ------------------------------------------------------------- invoices */

export function listInvoices(where: Prisma.InvoiceWhereInput): Promise<InvoiceListRow[]> {
  return prisma.invoice.findMany({
    where,
    orderBy: [{ invoiceDate: 'desc' }, { number: 'desc' }],
    take: 500,
    select: invoiceListSelect,
  });
}

export function findInvoiceById(id: string): Promise<InvoiceDetailRow | null> {
  return prisma.invoice.findUnique({ where: { id }, select: invoiceDetailSelect });
}

export function createInvoice(data: Prisma.InvoiceUncheckedCreateInput) {
  return prisma.invoice.create({ data, select: { id: true } });
}

export function updateInvoice(id: string, data: Prisma.InvoiceUpdateInput) {
  return prisma.invoice.update({ where: { id }, data, select: { id: true } });
}

export function deleteInvoice(id: string) {
  return prisma.invoice.delete({ where: { id }, select: { id: true } });
}

/** One email of an invoice, written only after the mail server accepted it. */
export function recordSend(data: {
  invoiceId: string;
  toEmails: string[];
  ccEmails: string[];
  sentById: string;
  messageId: string;
}) {
  return prisma.invoiceSend.create({
    data: { ...data, messageId: data.messageId || null },
    select: { id: true },
  });
}

/* ---------------------------------------------------------------- lines */

export function createLines(rows: Prisma.InvoiceLineUncheckedCreateInput[]) {
  // One line at a time rather than createMany: each carries its own price
  // lines, and a nested write keeps a job and its breakdown in one statement
  // so a half-written line cannot exist.
  return prisma.$transaction(
    rows.map((data) => prisma.invoiceLine.create({ data, select: { id: true } })),
  );
}

export function findLine(invoiceId: string, lineId: string) {
  return prisma.invoiceLine.findFirst({
    where: { id: lineId, invoiceId },
    select: { ...lineSelect, invoiceId: true, consignmentId: true },
  });
}

export function deleteLine(lineId: string) {
  return prisma.invoiceLine.delete({ where: { id: lineId }, select: { id: true } });
}

/** Replace a job's money and its whole breakdown in one go. */
export function replaceLinePrices(
  lineId: string,
  data: Prisma.InvoiceLineUpdateInput,
  priceLines: Omit<Prisma.InvoicePriceLineUncheckedCreateInput, 'invoiceLineId'>[],
) {
  return prisma.$transaction([
    prisma.invoicePriceLine.deleteMany({ where: { invoiceLineId: lineId } }),
    prisma.invoiceLine.update({ where: { id: lineId }, data, select: { id: true } }),
    prisma.invoicePriceLine.createMany({
      data: priceLines.map((p) => ({ ...p, invoiceLineId: lineId })),
    }),
  ]);
}

/** Recompute an invoice's headline totals from the lines beneath it. */
export async function refreshTotals(invoiceId: string) {
  const sum = await prisma.invoiceLine.aggregate({
    where: { invoiceId },
    _sum: {
      baseAmount: true,
      serviceAmount: true,
      levyAmount: true,
      taxAmount: true,
      grandTotal: true,
    },
  });

  return prisma.invoice.update({
    where: { id: invoiceId },
    data: {
      baseTotal: sum._sum.baseAmount ?? 0,
      serviceTotal: sum._sum.serviceAmount ?? 0,
      levyTotal: sum._sum.levyAmount ?? 0,
      taxTotal: sum._sum.taxAmount ?? 0,
      grandTotal: sum._sum.grandTotal ?? 0,
    },
    select: { id: true },
  });
}

/* ----------------------------------------------------------- the pool */

/**
 * Delivered jobs for this customer that no invoice has claimed.
 *
 * `invoiceLine: null` is the whole of "uninvoiced" — the unique constraint on
 * `invoice_lines.consignmentId` means a job is on an invoice or it is not, with
 * no third state to get out of step with.
 */
export function findInvoiceableConsignments(args: {
  clientId: string;
  from?: Date;
  to?: Date;
  ids?: string[];
}) {
  return prisma.consignment.findMany({
    where: {
      clientId: args.clientId,
      status: 'DELIVERED',
      invoiceLine: null,
      ...(args.ids ? { id: { in: args.ids } } : {}),
      ...(args.from || args.to
        ? { deliveredAt: { ...(args.from ? { gte: args.from } : {}), ...(args.to ? { lte: args.to } : {}) } }
        : {}),
    },
    orderBy: { deliveredAt: 'asc' },
    take: 500,
    select: {
      id: true,
      orderNo: true,
      clientReference: true,
      deliveredAt: true,
      senderName: true,
      senderCity: true,
      senderPostcode: true,
      senderLat: true,
      senderLng: true,
      receiverName: true,
      receiverCity: true,
      receiverPostcode: true,
      receiverLat: true,
      receiverLng: true,
      pickupAfter: true,
      deliverBefore: true,
      serviceLevelId: true,
      freightItemId: true,
      clientId: true,
      items: { select: { qty: true, weightLb: true } },
      // Ticked when the order was logged. Ids only: the price is read from
      // the rate card at the moment the job is invoiced.
      services: { select: { additionalServiceId: true } },
    },
  });
}

export type InvoiceableRow = Awaited<ReturnType<typeof findInvoiceableConsignments>>[number];

/**
 * One job, in the same shape, **whether or not it is already on an invoice**.
 *
 * Re-pricing needs this and the pool query cannot give it: that one exists to
 * find work nobody has billed yet, so it filters out exactly the job a reprice
 * is about.
 */
export async function findPriceableConsignment(id: string): Promise<InvoiceableRow | null> {
  const rows = await prisma.consignment.findMany({
    where: { id },
    take: 1,
    select: {
      id: true,
      orderNo: true,
      clientReference: true,
      deliveredAt: true,
      senderName: true,
      senderCity: true,
      senderPostcode: true,
      senderLat: true,
      senderLng: true,
      receiverName: true,
      receiverCity: true,
      receiverPostcode: true,
      receiverLat: true,
      receiverLng: true,
      pickupAfter: true,
      deliverBefore: true,
      serviceLevelId: true,
      freightItemId: true,
      clientId: true,
      items: { select: { qty: true, weightLb: true } },
      services: { select: { additionalServiceId: true } },
    },
  });
  return rows[0] ?? null;
}

/* ------------------------------------------------------ pricing inputs */

/** The active rate card for this client on this day, if there is exactly one. */
export function findActiveCardFor(clientId: string, on: Date) {
  return prisma.rateCard.findMany({
    where: { clientId, active: true, validFrom: { lte: on }, validTo: { gte: on } },
    orderBy: { validFrom: 'desc' },
    select: { id: true, name: true, levyPct: true, currency: true, zoneListId: true },
  });
}

/** The charge the system adds itself when a job runs outside business hours. */
export function findAfterHoursService() {
  return prisma.additionalService.findFirst({
    where: { trigger: 'AFTER_HOURS', active: true },
    select: {
      id: true,
      name: true,
      weekdayFrom: true,
      weekdayTo: true,
      weekendFrom: true,
      weekendTo: true,
    },
  });
}

/**
 * When the driver said they had arrived at the drop, and when the proof landed.
 *
 * There is no `atDeliveryAt` column, so arrival is the newest tracking event
 * that moved the job to AT_DELIVERY. Either end missing means no waiting was
 * recorded, which is different from a wait of zero but bills the same.
 */
export async function findWaitWindow(consignmentId: string) {
  const [arrived, proof] = await Promise.all([
    prisma.trackingEvent.findFirst({
      where: { consignmentId, toStatus: 'AT_DELIVERY' },
      orderBy: { recordedAt: 'desc' },
      select: { recordedAt: true },
    }),
    prisma.proofOfDelivery.findFirst({
      where: { consignmentId, leg: 'DELIVERY' },
      select: { capturedAt: true },
    }),
  ]);
  return { arrivedAt: arrived?.recordedAt ?? null, provedAt: proof?.capturedAt ?? null };
}

export function findClientById(id: string) {
  return prisma.client.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      code: true,
      taxExempt: true,
      paymentTermsDays: true,
      line1: true,
      city: true,
      province: true,
      postcode: true,
      email: true,
    },
  });
}
