import type { PriceLineKind } from '@prisma/client';
import { quoteRateCard, type QuoteLine } from '../rateCards/rateCards.service.js';
import { billableDistanceM } from '../routing/routing.google.js';
import * as repo from './invoices.repository.js';

/** One row of the breakdown, ready to be stored or shown. */
export interface PricedLine {
  kind: PriceLineKind;
  key: string;
  label: string;
  detail: string | null;
  amount: number;
  sortOrder: number;
  editable: boolean;
}

export interface PricedJob {
  consignmentId: string;
  orderNo: string;
  ok: boolean;
  /** Why it could not be priced. Null when `ok`. */
  problem: string | null;
  rateCardId: string | null;
  levyPct: number;
  distanceKm: number | null;
  waitMinutes: number | null;
  baseAmount: number;
  serviceAmount: number;
  levyAmount: number;
  taxAmount: number;
  grandTotal: number;
  ratingNotes: string;
  lines: PricedLine[];
  warnings: string[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Which bucket a quote line belongs to.
 *
 * Keyed off the engine's own `key`, never off the label: a levy renamed in the
 * UI still has to behave like a levy, and the totals depend on it.
 */
function kindOf(key: string): PriceLineKind {
  if (key === 'base') return 'BASE';
  if (key === 'distance') return 'DISTANCE';
  if (key === 'waiting') return 'WAITING';
  if (key === 'levy') return 'LEVY';
  if (key === 'tax') return 'TAX';
  if (key.startsWith('service:')) return 'SERVICE';
  return 'MANUAL';
}

/**
 * Only the carriage is editable.
 *
 * Levy and tax are percentages of the rows above them. If a person could type
 * over them the invoice would stop agreeing with its own arithmetic, and the
 * printed "Levy 27.5%" would be a label rather than a fact.
 */
const EDITABLE: PriceLineKind[] = ['BASE', 'DISTANCE', 'WAITING', 'MANUAL'];

/* -------------------------------------------------------- after hours */

/** "08:00" -> 480. Null for anything unparseable, which reads as "no window". */
function minutesOfDay(hhmm: string | null): number | null {
  if (!hhmm) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Is this moment outside the business window for its own day?
 *
 * Weekends get their own pair, because Saturday is not a short Monday. A day
 * with no window configured is treated as entirely within hours: an absent
 * setting must not quietly start charging people.
 */
function outsideHours(
  at: Date,
  hours: {
    weekdayFrom: string | null;
    weekdayTo: string | null;
    weekendFrom: string | null;
    weekendTo: string | null;
  },
): boolean {
  const day = at.getDay();
  const weekend = day === 0 || day === 6;
  const from = minutesOfDay(weekend ? hours.weekendFrom : hours.weekdayFrom);
  const to = minutesOfDay(weekend ? hours.weekendTo : hours.weekdayTo);
  if (from === null || to === null) return false;

  const now = at.getHours() * 60 + at.getMinutes();
  return now < from || now > to;
}

/* ------------------------------------------------------------ pricing */

/**
 * What one delivered job is worth.
 *
 * Reads nothing back from a previous pricing and writes nothing: the caller
 * decides whether the answer becomes an invoice line. A job that cannot be
 * priced comes back with `ok: false` and a sentence saying why, rather than
 * throwing — a billing run of fifty jobs must not be stopped by one of them.
 */
export async function priceConsignment(
  job: repo.InvoiceableRow,
  ctx: { taxPct: number },
): Promise<PricedJob> {
  const blank = (problem: string): PricedJob => ({
    consignmentId: job.id,
    orderNo: job.orderNo,
    ok: false,
    problem,
    rateCardId: null,
    levyPct: 0,
    distanceKm: null,
    waitMinutes: null,
    baseAmount: 0,
    serviceAmount: 0,
    levyAmount: 0,
    taxAmount: 0,
    grandTotal: 0,
    ratingNotes: '',
    lines: [],
    warnings: [],
  });

  const on = job.deliveredAt ?? new Date();

  if (!job.receiverPostcode) {
    return blank('No delivery postcode, so no zone and no rate.');
  }
  if (!job.serviceLevelId) {
    return blank('No service level on this job.');
  }

  const cards = await repo.findActiveCardFor(job.clientId, on);
  if (cards.length === 0) {
    return blank(`No active rate card for this customer on ${on.toISOString().slice(0, 10)}.`);
  }
  // More than one is prevented by an exclusion constraint on active cards, so
  // this is belt and braces rather than a real branch.
  const card = cards[0];

  const warnings: string[] = [];

  /* --- distance ------------------------------------------------------- */
  let distanceKm: number | null = null;
  if (
    job.senderLat != null &&
    job.senderLng != null &&
    job.receiverLat != null &&
    job.receiverLng != null
  ) {
    try {
      const m = await billableDistanceM(
        { lat: job.senderLat, lng: job.senderLng },
        { lat: job.receiverLat, lng: job.receiverLng },
      );
      if (m != null) distanceKm = round2(m / 1000);
      else warnings.push('No road route was found, so distance was not charged.');
    } catch {
      // Degrade rather than fail, the way every other routing caller does.
      warnings.push('The routing engine was unreachable, so distance was not charged.');
    }
  } else {
    warnings.push('One end of this job has no coordinate, so distance was not charged.');
  }

  /* --- waiting -------------------------------------------------------- */
  let waitMinutes: number | null = null;
  const wait = await repo.findWaitWindow(job.id);
  /*
   * The wait ends when the proof lands. `deliveredAt` is the fallback because
   * it is stamped inside the very transaction that stores the proof, so the
   * two cannot disagree — and a job whose photo has since been replaced, or
   * one delivered before proof capture existed, still bills its waiting time.
   */
  const endedAt = wait.provedAt ?? job.deliveredAt;
  if (wait.arrivedAt && endedAt) {
    const mins = Math.round((endedAt.getTime() - wait.arrivedAt.getTime()) / 60000);
    // A negative gap means the clocks disagree, not that time ran backwards.
    waitMinutes = mins > 0 ? mins : 0;
  }

  /* --- accessorials ------------------------------------------------------ */
  // What the operator ticked when the order was logged. Names were stored;
  // the price comes from the card now, so a renegotiated rate applies to work
  // already done but not yet billed.
  const extras: string[] = [...job.services.map((s) => s.additionalServiceId)];

  /* --- after hours ----------------------------------------------------- */
  const afterHours = await repo.findAfterHoursService();
  if (afterHours) {
    /*
     * The requested times decide this, not the actual ones and not the moment
     * the order was logged. A job booked for collection at 20:00 is an
     * after-hours job whether or not the driver ran late, and a job booked
     * inside hours is not one because the paperwork was typed at midnight.
     *
     * OR, charged once: a run that starts late and finishes later is still one
     * trip, and billing both ends would charge twice for the same evening.
     */
    if (outsideHours(job.pickupAfter, afterHours) || outsideHours(job.deliverBefore, afterHours)) {
      extras.push(afterHours.id);
    }
  }

  /* --- the quote -------------------------------------------------------- */
  const quote = await quoteRateCard(card.id, {
    deliveryPostalCode: job.receiverPostcode,
    serviceLevelId: job.serviceLevelId,
    ...(job.freightItemId ? { freightItemId: job.freightItemId } : {}),
    distanceKm: distanceKm ?? 0,
    waitMinutes: waitMinutes ?? 0,
    additionalServiceIds: extras,
    taxPct: ctx.taxPct,
    on,
  });

  if (!quote.ok) {
    const out = blank(quote.problem ?? 'This job could not be priced.');
    out.rateCardId = card.id;
    out.warnings = [...warnings, ...quote.warnings];
    return out;
  }

  /*
   * Which service lines a person may correct.
   *
   * A charge an operator ticked is a judgement they made, so they may change
   * what it costs. A charge the system added from the clock is not — editing
   * it would let the invoice disagree with the rule that produced it. The
   * ticked ids are the whole distinction; nothing else has to be looked up.
   */
  const ticked = new Set(job.services.map((s) => `service:${s.additionalServiceId}`));

  const lines: PricedLine[] = quote.lines.map((l: QuoteLine, i: number) => {
    const kind = kindOf(l.key);
    return {
      kind,
      key: l.key,
      label: l.label,
      detail: l.detail,
      amount: l.amount,
      sortOrder: i,
      editable: kind === 'SERVICE' ? ticked.has(l.key) : EDITABLE.includes(kind),
    };
  });

  const sumOf = (...kinds: PriceLineKind[]) =>
    round2(lines.filter((l) => kinds.includes(l.kind)).reduce((s, l) => s + l.amount, 0));

  const baseAmount = sumOf('BASE', 'DISTANCE', 'WAITING');
  const serviceAmount = sumOf('SERVICE', 'MANUAL');
  const levyAmount = sumOf('LEVY');
  const taxAmount = sumOf('TAX');

  return {
    consignmentId: job.id,
    orderNo: job.orderNo,
    ok: true,
    problem: null,
    rateCardId: card.id,
    levyPct: Number(card.levyPct),
    distanceKm,
    waitMinutes,
    baseAmount,
    serviceAmount,
    levyAmount,
    taxAmount,
    grandTotal: round2(baseAmount + serviceAmount + levyAmount + taxAmount),
    ratingNotes: ratingNotes(quote, card.name),
    lines,
    warnings: [...warnings, ...quote.warnings],
  };
}

/**
 * The working, in words, frozen alongside the money.
 *
 * Written once at pricing time so a biller three months later can see how a
 * number was reached without re-running anything — and so they can see it even
 * after the rate card that produced it has been edited or deleted.
 */
function ratingNotes(
  quote: Awaited<ReturnType<typeof quoteRateCard>>,
  cardName: string,
): string {
  const head = `${quote.card.client.name} (${quote.serviceLevel?.name ?? 'no service level'})`;
  const route = `${quote.from?.zoneName ?? 'anywhere'} <> ${quote.to?.zoneName ?? 'unzoned'}`;
  const body = quote.lines
    .filter((l) => l.amount !== 0)
    .map((l) => `${l.label} = ${l.amount.toFixed(2)}${l.detail ? `  (${l.detail})` : ''}`);
  return [head, route, `--- ${cardName} ---`, ...body, `Total = ${quote.total.toFixed(2)}`].join(
    '\n',
  );
}

/** Price a batch, one after another so the routing cache earns its keep. */
export async function priceMany(
  jobs: repo.InvoiceableRow[],
  ctx: { taxPct: number },
): Promise<PricedJob[]> {
  const out: PricedJob[] = [];
  for (const job of jobs) out.push(await priceConsignment(job, ctx));
  return out;
}
