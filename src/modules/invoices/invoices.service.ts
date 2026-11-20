import type { Prisma } from '@prisma/client';
import { AppError } from '../../utils/httpError.js';
import type {
  AddLinesInput,
  CreateInvoiceInput,
  EditLineInput,
  ListInvoicesQuery,
  PreviewInvoiceInput,
  UpdateFinanceSettingsInput,
  UpdateInvoiceInput,
} from '../../schemas/invoice.schema.js';
import * as repo from './invoices.repository.js';
import { priceMany, type PricedJob, type PricedLine } from './pricing.service.js';

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (d: Prisma.Decimal | number | null) => (d === null ? null : Number(d));

/* ---------------------------------------------------------------- DTOs */

function toLineDto(row: repo.InvoiceLineRow) {
  const c = row.consignment;
  return {
    id: row.id,
    consignment: {
      id: c.id,
      orderNo: c.orderNo,
      clientReference: c.clientReference,
      status: c.status,
      deliveredAt: c.deliveredAt,
      pickedUpAt: c.pickedUpAt,
      date: c.createdAt,
      sender: {
        name: c.senderName,
        line1: c.senderLine1,
        city: c.senderCity,
        province: c.senderProvince,
        postcode: c.senderPostcode,
      },
      receiver: {
        name: c.receiverName,
        line1: c.receiverLine1,
        city: c.receiverCity,
        province: c.receiverProvince,
        postcode: c.receiverPostcode,
      },
      qty: c.items.reduce((s, i) => s + i.qty, 0),
      weightLb: round2(c.items.reduce((s, i) => s + Number(i.weightLb ?? 0), 0)),
      items: c.items.map((i) => ({
        qty: i.qty,
        description: i.description,
        weightLb: num(i.weightLb),
      })),
    },
    rateCardId: row.rateCardId,
    levyPct: Number(row.levyPct),
    distanceKm: num(row.distanceKm),
    waitMinutes: row.waitMinutes,
    baseAmount: Number(row.baseAmount),
    serviceAmount: Number(row.serviceAmount),
    levyAmount: Number(row.levyAmount),
    taxAmount: Number(row.taxAmount),
    grandTotal: Number(row.grandTotal),
    ratingNotes: row.ratingNotes,
    edited: row.edited,
    priceLines: row.priceLines.map((p) => ({
      id: p.id,
      kind: p.kind,
      key: p.key,
      label: p.label,
      detail: p.detail,
      amount: Number(p.amount),
      sortOrder: p.sortOrder,
      editable: p.editable,
    })),
  };
}

function toInvoiceDto(row: repo.InvoiceListRow | repo.InvoiceDetailRow) {
  const detail = 'lines' in row ? row.lines : null;
  return {
    id: row.id,
    number: row.number,
    client: { id: row.client.id, name: row.client.name, code: row.client.code },
    billTo: {
      name: row.client.name,
      email: row.client.email,
      line1: row.client.line1,
      cityLine: [row.client.city, row.client.postcode, row.client.province]
        .filter(Boolean)
        .join(', '),
    },
    invoiceDate: row.invoiceDate,
    dueDate: row.dueDate,
    status: row.status,
    currency: row.currency,
    taxPct: Number(row.taxPct),
    baseTotal: Number(row.baseTotal),
    serviceTotal: Number(row.serviceTotal),
    levyTotal: Number(row.levyTotal),
    taxTotal: Number(row.taxTotal),
    grandTotal: Number(row.grandTotal),
    notes: row.notes,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt,
    consignmentCount: row._count.lines,
    /**
     * One printed line per distinct levy percentage, which is how the sample
     * invoices read: jobs priced on cards with different levies cannot be
     * collapsed into a single "Levy" figure without losing the rate.
     */
    ...(detail
      ? {
          lines: detail.map(toLineDto),
          sends:
            'sends' in row
              ? row.sends.map((s) => ({
                  id: s.id,
                  to: s.toEmails,
                  cc: s.ccEmails,
                  sentAt: s.sentAt,
                  sentBy: s.sentBy.email,
                }))
              : [],
          levyBreakdown: levyByRate(detail),
          totalQty: detail.reduce(
            (s, l) => s + l.consignment.items.reduce((q, i) => q + i.qty, 0),
            0,
          ),
          totalWeightLb: round2(
            detail.reduce(
              (s, l) => s + l.consignment.items.reduce((w, i) => w + Number(i.weightLb ?? 0), 0),
              0,
            ),
          ),
        }
      : {}),
  };
}

function levyByRate(lines: repo.InvoiceDetailRow['lines']) {
  const by = new Map<number, number>();
  for (const l of lines) {
    const pct = Number(l.levyPct);
    const amount = Number(l.levyAmount);
    if (pct <= 0 || amount === 0) continue;
    by.set(pct, round2((by.get(pct) ?? 0) + amount));
  }
  return [...by.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([pct, amount]) => ({ pct, amount, label: `Levy ${pct}%` }));
}

/* ------------------------------------------------------------ guards */

async function invoiceOr404(id: string) {
  const row = await repo.findInvoiceById(id);
  if (!row) throw AppError.notFound('Invoice not found');
  return row;
}

/**
 * OPEN and CLOSED differ in exactly one way: whether jobs may join or leave.
 * APPROVED freezes everything, and is the only state with a person's name
 * against it — which is the whole reason it cannot be edited through.
 */
function mustBeOpen(row: { status: string; number: string }) {
  if (row.status !== 'OPEN') {
    throw AppError.conflict(
      row.status === 'APPROVED'
        ? `Invoice ${row.number} is approved and locked. Un-approve it first.`
        : `Invoice ${row.number} is closed. Re-open it to change which jobs are on it.`,
    );
  }
}

function mustBeEditable(row: { status: string; number: string }) {
  if (row.status === 'APPROVED') {
    throw AppError.conflict(
      `Invoice ${row.number} is approved and locked. Un-approve it first.`,
    );
  }
}

/* ---------------------------------------------------------- settings */

export async function getFinanceSettings() {
  const s = await repo.getSettings();
  return {
    taxPct: Number(s.taxPct),
    invoicePrefix: s.invoicePrefix,
    invoiceNextNumber: s.invoiceNextNumber,
  };
}

export async function updateFinanceSettings(input: UpdateFinanceSettingsInput) {
  await repo.updateSettings(input);
  return getFinanceSettings();
}

/* ----------------------------------------------------------- preview */

/**
 * What could go on an invoice for this customer, priced but not committed.
 *
 * Jobs that cannot be priced are returned too, with the reason, rather than
 * being filtered out. A job silently missing from a billing run is how revenue
 * goes astray; a job listed with "no active rate card" gets fixed.
 */
export async function previewInvoice(input: PreviewInvoiceInput) {
  const client = await repo.findClientById(input.clientId);
  if (!client) throw AppError.badRequest('That customer does not exist');

  const settings = await repo.getSettings();
  const taxPct = client.taxExempt ? 0 : Number(settings.taxPct);

  // Inclusive of the whole closing day: an operator picking "to the 7th" means
  // everything delivered on the 7th, not everything up to midnight entering it.
  const to = new Date(input.to);
  to.setHours(23, 59, 59, 999);

  const jobs = await repo.findInvoiceableConsignments({
    clientId: input.clientId,
    from: input.from,
    to,
  });
  const priced = await priceMany(jobs, { taxPct });

  return {
    client: { id: client.id, name: client.name, code: client.code, taxExempt: client.taxExempt },
    taxPct,
    jobs: priced.map((p, i) => ({ ...p, ...summaryOf(jobs[i]) })),
    totals: totalsOf(priced.filter((p) => p.ok)),
  };
}

function summaryOf(job: repo.InvoiceableRow) {
  return {
    clientReference: job.clientReference,
    deliveredAt: job.deliveredAt,
    senderName: job.senderName,
    receiverName: job.receiverName,
    receiverCity: job.receiverCity,
    qty: job.items.reduce((s, i) => s + i.qty, 0),
    weightLb: round2(job.items.reduce((s, i) => s + Number(i.weightLb ?? 0), 0)),
  };
}

function totalsOf(priced: PricedJob[]) {
  const sum = (pick: (p: PricedJob) => number) => round2(priced.reduce((s, p) => s + pick(p), 0));
  return {
    count: priced.length,
    baseTotal: sum((p) => p.baseAmount),
    serviceTotal: sum((p) => p.serviceAmount),
    levyTotal: sum((p) => p.levyAmount),
    taxTotal: sum((p) => p.taxAmount),
    grandTotal: sum((p) => p.grandTotal),
  };
}

/* ------------------------------------------------------------ create */

export async function createInvoice(input: CreateInvoiceInput, actorId: string) {
  const client = await repo.findClientById(input.clientId);
  if (!client) throw AppError.badRequest('That customer does not exist');

  /*
   * An empty invoice is a legitimate thing to raise: the customer is being
   * billed this cycle and the work is still going out of the door, so the
   * header exists first and jobs join it later.
   *
   * Asking for *specific* jobs and getting none is still an error, though —
   * that means every id was wrong, already billed, or not delivered, and
   * silently handing back an empty invoice would look like it had worked.
   */
  const wanted = input.consignmentIds;

  const jobs =
    wanted.length === 0
      ? []
      : await repo.findInvoiceableConsignments({ clientId: input.clientId, ids: wanted });

  if (wanted.length > 0 && jobs.length === 0) {
    throw AppError.badRequest(
      'None of those jobs can be invoiced — they must be delivered and not already on an invoice.',
    );
  }

  const settings = await repo.getSettings();
  const taxPct = client.taxExempt ? 0 : Number(settings.taxPct);
  const priced = jobs.length === 0 ? [] : (await priceMany(jobs, { taxPct })).filter((p) => p.ok);
  if (wanted.length > 0 && priced.length === 0) {
    throw AppError.badRequest('None of those jobs could be priced. See the preview for why.');
  }

  const invoiceDate = input.invoiceDate ?? new Date();
  const dueDate = new Date(invoiceDate);
  dueDate.setDate(dueDate.getDate() + client.paymentTermsDays);

  // The number is taken outside the insert on purpose; see the repository.
  const number = await repo.nextInvoiceNumber();

  const created = await repo.createInvoice({
    number,
    clientId: client.id,
    invoiceDate,
    dueDate,
    status: 'OPEN',
    taxPct,
    createdById: actorId,
    ...(input.notes ? { notes: input.notes } : {}),
  });

  if (priced.length > 0) {
    await repo.createLines(priced.map((p) => lineCreate(created.id, p)));
    await repo.refreshTotals(created.id);
  }

  return toInvoiceDto(await invoiceOr404(created.id));
}

function lineCreate(invoiceId: string, p: PricedJob): Prisma.InvoiceLineUncheckedCreateInput {
  return {
    invoiceId,
    consignmentId: p.consignmentId,
    rateCardId: p.rateCardId,
    levyPct: p.levyPct,
    distanceKm: p.distanceKm,
    waitMinutes: p.waitMinutes,
    baseAmount: p.baseAmount,
    serviceAmount: p.serviceAmount,
    levyAmount: p.levyAmount,
    taxAmount: p.taxAmount,
    grandTotal: p.grandTotal,
    ratingNotes: p.ratingNotes,
    priceLines: { create: p.lines.map(priceLineCreate) },
  };
}

function priceLineCreate(l: PricedLine) {
  return {
    kind: l.kind,
    key: l.key,
    label: l.label,
    detail: l.detail,
    amount: l.amount,
    sortOrder: l.sortOrder,
    editable: l.editable,
  };
}

/* -------------------------------------------------------------- read */

export async function listInvoices(q: ListInvoicesQuery) {
  const where: Prisma.InvoiceWhereInput = {
    ...(q.clientId ? { clientId: q.clientId } : {}),
    ...(q.status ? { status: q.status } : {}),
    ...(q.from || q.to
      ? { invoiceDate: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } }
      : {}),
    ...(q.q
      ? {
          OR: [
            { number: { contains: q.q, mode: 'insensitive' } },
            { client: { name: { contains: q.q, mode: 'insensitive' } } },
            { client: { code: { contains: q.q, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };

  return (await repo.listInvoices(where)).map(toInvoiceDto);
}

export async function getInvoice(id: string) {
  return toInvoiceDto(await invoiceOr404(id));
}

/* ------------------------------------------------------------ mutate */

export async function updateInvoice(id: string, input: UpdateInvoiceInput) {
  const row = await invoiceOr404(id);
  mustBeEditable(row);
  await repo.updateInvoice(id, input);
  return toInvoiceDto(await invoiceOr404(id));
}

export async function addLines(id: string, input: AddLinesInput) {
  const row = await invoiceOr404(id);
  mustBeOpen(row);

  const jobs = await repo.findInvoiceableConsignments({
    clientId: row.client.id,
    ids: input.consignmentIds,
  });
  if (jobs.length === 0) {
    throw AppError.badRequest(
      'None of those jobs can be added — they must be delivered, belong to this customer, and not already be on an invoice.',
    );
  }

  const priced = (await priceMany(jobs, { taxPct: Number(row.taxPct) })).filter((p) => p.ok);
  if (priced.length === 0) {
    throw AppError.badRequest('None of those jobs could be priced.');
  }

  await repo.createLines(priced.map((p) => lineCreate(id, p)));
  await repo.refreshTotals(id);
  return toInvoiceDto(await invoiceOr404(id));
}

export async function removeLine(id: string, lineId: string) {
  const row = await invoiceOr404(id);
  mustBeOpen(row);

  const line = await repo.findLine(id, lineId);
  if (!line) throw AppError.notFound('That job is not on this invoice');

  await repo.deleteLine(lineId);
  await repo.refreshTotals(id);
  return toInvoiceDto(await invoiceOr404(id));
}

/**
 * Override one job's carriage amounts, or its manual lines.
 *
 * Everything downstream is recomputed from what is left: change the base and
 * the levy follows, change either and the tax follows. Nothing recalculates
 * the *rate*, because the whole point of an override is that the rate card got
 * it wrong.
 */
export async function editLine(id: string, lineId: string, input: EditLineInput) {
  const row = await invoiceOr404(id);
  mustBeEditable(row);

  const line = await repo.findLine(id, lineId);
  if (!line) throw AppError.notFound('That job is not on this invoice');

  const kept = line.priceLines
    .filter((p) => p.kind !== 'LEVY' && p.kind !== 'TAX' && p.kind !== 'MANUAL')
    .map((p) => ({
      kind: p.kind,
      key: p.key,
      label: p.label,
      detail: p.detail,
      amount: Number(p.amount),
      sortOrder: p.sortOrder,
      editable: p.editable,
    }));

  const set = (kind: 'BASE' | 'DISTANCE' | 'WAITING', amount: number | undefined) => {
    if (amount === undefined) return;
    const found = kept.find((p) => p.kind === kind);
    if (found) {
      found.amount = amount;
      // The old detail described arithmetic that no longer produced this
      // number, so it would read as a lie. Say who changed it instead.
      found.detail = 'edited by hand';
    } else {
      kept.push({
        kind,
        key: kind.toLowerCase(),
        label: kind === 'BASE' ? 'Base rate' : kind === 'DISTANCE' ? 'Distance' : 'Waiting',
        detail: 'added by hand',
        amount,
        sortOrder: kept.length,
        editable: true,
      });
    }
  };

  set('BASE', input.baseAmount);
  set('DISTANCE', input.distanceAmount);
  set('WAITING', input.waitingAmount);

  /*
   * Service charges, corrected one by one.
   *
   * Refused rather than ignored when the line is not editable: a charge the
   * system added from the clock must keep agreeing with the rule that produced
   * it, and silently dropping the change would leave the operator believing
   * they had made one.
   */
  for (const s of input.serviceAmounts ?? []) {
    const row = kept.find((p) => p.key === s.key && p.kind === 'SERVICE');
    if (!row) throw AppError.badRequest(`No service charge "${s.key}" on this job`);
    if (!row.editable) {
      throw AppError.badRequest(`"${row.label}" is added by the system and cannot be re-priced`);
    }
    row.amount = s.amount;
    row.detail = 'edited by hand';
  }

  const manual =
    input.manualLines?.map((m, i) => ({
      kind: 'MANUAL' as const,
      key: `manual:${i}`,
      label: m.label,
      detail: 'added by hand',
      amount: m.amount,
      sortOrder: 500 + i,
      editable: true,
    })) ??
    line.priceLines
      .filter((p) => p.kind === 'MANUAL')
      .map((p) => ({
        kind: 'MANUAL' as const,
        key: p.key,
        label: p.label,
        detail: p.detail,
        amount: Number(p.amount),
        sortOrder: p.sortOrder,
        editable: true,
      }));

  const rebuilt = [...kept, ...manual].sort((a, b) => a.sortOrder - b.sortOrder);

  const sumOf = (...kinds: string[]) =>
    round2(rebuilt.filter((p) => kinds.includes(p.kind)).reduce((s, p) => s + p.amount, 0));

  const baseAmount = sumOf('BASE', 'DISTANCE', 'WAITING');
  const serviceAmount = sumOf('SERVICE', 'MANUAL');

  // The levy rides on the carriage only, exactly as the quote engine has it.
  const levyPct = Number(line.levyPct);
  const levyAmount = round2((baseAmount * levyPct) / 100);
  if (levyAmount !== 0) {
    rebuilt.push({
      kind: 'LEVY',
      key: 'levy',
      label: `Levy ${levyPct}%`,
      detail: `${levyPct}% of ${baseAmount.toFixed(2)} base price`,
      amount: levyAmount,
      sortOrder: 900,
      editable: false,
    });
  }

  const taxPct = Number(row.taxPct);
  const subTotal = round2(baseAmount + serviceAmount + levyAmount);
  const taxAmount = taxPct > 0 ? round2((subTotal * taxPct) / 100) : 0;
  if (taxAmount !== 0) {
    rebuilt.push({
      kind: 'TAX',
      key: 'tax',
      label: 'Tax',
      detail: `${taxPct}% of ${subTotal.toFixed(2)} sub total`,
      amount: taxAmount,
      sortOrder: 950,
      editable: false,
    });
  }

  await repo.replaceLinePrices(
    lineId,
    {
      baseAmount,
      serviceAmount,
      levyAmount,
      taxAmount,
      grandTotal: round2(subTotal + taxAmount),
      edited: true,
    },
    rebuilt,
  );
  await repo.refreshTotals(id);
  return toInvoiceDto(await invoiceOr404(id));
}

/** Throw away the hand edits on one job and ask the rate card again. */
export async function repriceLine(id: string, lineId: string) {
  const row = await invoiceOr404(id);
  mustBeEditable(row);

  const line = await repo.findLine(id, lineId);
  if (!line) throw AppError.notFound('That job is not on this invoice');

  // Not the pool query: that one filters out anything already invoiced, which
  // is precisely the job being re-priced.
  const job = await repo.findPriceableConsignment(line.consignmentId);
  if (!job) {
    throw AppError.conflict('That job can no longer be priced from a rate card.');
  }

  const [p] = await priceMany([job], { taxPct: Number(row.taxPct) });
  if (!p.ok) throw AppError.conflict(p.problem ?? 'That job could not be re-priced.');

  await repo.replaceLinePrices(
    lineId,
    {
      rateCard: p.rateCardId ? { connect: { id: p.rateCardId } } : { disconnect: true },
      levyPct: p.levyPct,
      distanceKm: p.distanceKm,
      waitMinutes: p.waitMinutes,
      baseAmount: p.baseAmount,
      serviceAmount: p.serviceAmount,
      levyAmount: p.levyAmount,
      taxAmount: p.taxAmount,
      grandTotal: p.grandTotal,
      ratingNotes: p.ratingNotes,
      edited: false,
    },
    p.lines.map(priceLineCreate),
  );
  await repo.refreshTotals(id);
  return toInvoiceDto(await invoiceOr404(id));
}

/* ----------------------------------------------------------- approval */

export async function approveInvoice(id: string, actorId: string) {
  const row = await invoiceOr404(id);
  if (row.status === 'APPROVED') {
    throw AppError.conflict(`Invoice ${row.number} is already approved.`);
  }
  if (row.lines.length === 0) {
    throw AppError.conflict('An invoice with no jobs on it cannot be approved.');
  }

  await repo.updateInvoice(id, {
    status: 'APPROVED',
    approvedBy: { connect: { id: actorId } },
    approvedAt: new Date(),
  });
  return toInvoiceDto(await invoiceOr404(id));
}

/**
 * Back to CLOSED, with the stamps cleared.
 *
 * Clearing them is the point: an invoice that was approved, changed and
 * re-approved must show the second approval, not the first. Leaving the
 * original name attached would put someone's signature on numbers they never
 * saw.
 */
export async function unapproveInvoice(id: string) {
  const row = await invoiceOr404(id);
  if (row.status !== 'APPROVED') {
    throw AppError.conflict(`Invoice ${row.number} is not approved.`);
  }

  await repo.updateInvoice(id, {
    status: 'CLOSED',
    approvedBy: { disconnect: true },
    approvedAt: null,
  });
  return toInvoiceDto(await invoiceOr404(id));
}

export async function deleteInvoice(id: string) {
  const row = await invoiceOr404(id);
  if (row.status === 'APPROVED') {
    throw AppError.conflict(
      `Invoice ${row.number} is approved and locked and cannot be deleted. Un-approve it first.`,
    );
  }
  await repo.deleteInvoice(id);
}
