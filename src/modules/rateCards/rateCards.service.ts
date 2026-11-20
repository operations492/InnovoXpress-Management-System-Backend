import type { Prisma } from '@prisma/client';
import { AppError } from '../../utils/httpError.js';
import type {
  CreateRateCardInput,
  ListRatesQuery,
  PutCardServiceInput,
  PutRouteRateInput,
  QuoteInput,
  UpdateRateCardInput,
} from '../../schemas/rateCard.schema.js';
import * as repo from './rateCards.repository.js';
import * as zones from '../zones/zones.service.js';

/*
 * A rate card is one customer's price book over one zone list, for one window of
 * dates. Inside it, every priced route is an exact five-part key: this card,
 * this service level, this freight item, from this zone, to that zone.
 *
 * Two rules are worth stating because they are easy to "improve" by mistake:
 *
 *   - Routes are directional and there is no reverse fallback. Toronto to
 *     Vancouver is a different journey from Vancouver to Toronto and is often a
 *     different price; inventing the reverse would put a number on an invoice
 *     that nobody agreed to.
 *   - Two active cards for one customer may not overlap in time. The database
 *     enforces it with an exclusion constraint; the check below exists so the
 *     operator is told which card is in the way.
 */

/** Decimal to a plain number for JSON. Via the string, so no Decimal API leaks. */
const num = (d: Prisma.Decimal) => Number(d.toString());

function toCardDto(row: repo.CardRow) {
  return {
    id: row.id,
    name: row.name,
    client: row.client,
    zoneList: row.zoneList,
    validFrom: row.validFrom,
    validTo: row.validTo,
    currency: row.currency,
    active: row.active,
    memo: row.memo,
    // Prisma hands Decimal back as an object; the API has always spoken numbers.
    levyPct: Number(row.levyPct),
    rateCount: row._count.rates,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toRateDto(row: repo.RateRow) {
  return {
    id: row.id,
    serviceLevel: row.serviceLevel,
    freightItem: row.freightItem,
    toZone: row.toZone,
    baseRate: num(row.baseRate),
    freeKm: num(row.freeKm),
    ratePerKm: num(row.ratePerKm),
    freeWaitMinutes: row.freeWaitMinutes,
    waitRatePerMinute: num(row.waitRatePerMinute),
    active: row.active,
    updatedAt: row.updatedAt,
  };
}

/* ------------------------------------------------------------------ cards */

export async function listRateCards(clientId: string | undefined, includeInactive: boolean) {
  const rows = await repo.listCards(clientId, includeInactive);
  return rows.map(toCardDto);
}

async function cardOr404(id: string) {
  const row = await repo.findCardById(id);
  if (!row) throw AppError.notFound('Rate card not found');
  return row;
}

export async function getRateCard(id: string) {
  const card = await cardOr404(id);
  const rates = await repo.listRates(id, {});
  return { ...toCardDto(card), rates: rates.map(toRateDto) };
}

async function assertNoOverlap(
  clientId: string,
  validFrom: Date,
  validTo: Date,
  exceptId?: string,
) {
  const clash = await repo.findOverlappingCard(clientId, validFrom, validTo, exceptId);
  if (!clash) return;

  const span = (a: Date, b: Date) =>
    `${a.toISOString().slice(0, 10)} to ${b.toISOString().slice(0, 10)}`;
  throw AppError.conflict(
    `"${clash.name}" already covers this customer for ${span(clash.validFrom, clash.validTo)}`,
  );
}

export async function createRateCard(input: CreateRateCardInput) {
  const client = await repo.findClientById(input.clientId);
  if (!client) throw AppError.badRequest('That customer does not exist');

  const zoneList = await repo.findZoneListById(input.zoneListId);
  if (!zoneList) throw AppError.badRequest('That zone list does not exist');

  await assertNoOverlap(input.clientId, input.validFrom, input.validTo);

  return toCardDto(
    await repo.createCard({
      name: input.name,
      clientId: input.clientId,
      zoneListId: input.zoneListId,
      validFrom: input.validFrom,
      validTo: input.validTo,
      ...(input.memo !== undefined ? { memo: input.memo } : {}),
      ...(input.levyPct !== undefined ? { levyPct: input.levyPct } : {}),
    }),
  );
}

export async function updateRateCard(id: string, input: UpdateRateCardInput) {
  const existing = await cardOr404(id);

  const validFrom = input.validFrom ?? existing.validFrom;
  const validTo = input.validTo ?? existing.validTo;
  if (validTo < validFrom) {
    throw AppError.badRequest('The expiry date cannot be before the effective date');
  }

  // Re-check whenever the window moves or the card is being switched back on.
  const movedOrRevived =
    input.validFrom !== undefined || input.validTo !== undefined || input.active === true;
  if (movedOrRevived && (input.active ?? existing.active)) {
    await assertNoOverlap(existing.clientId, validFrom, validTo, id);
  }

  if (input.zoneListId !== undefined && input.zoneListId !== existing.zoneListId) {
    if (existing._count.rates > 0) {
      throw AppError.conflict(
        'This card already prices routes, so its zone list cannot be changed; clear the rates first',
      );
    }
    const zoneList = await repo.findZoneListById(input.zoneListId);
    if (!zoneList) throw AppError.badRequest('That zone list does not exist');
  }

  return toCardDto(
    await repo.updateCard(id, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.zoneListId !== undefined
        ? { zoneList: { connect: { id: input.zoneListId } } }
        : {}),
      ...(input.validFrom !== undefined ? { validFrom: input.validFrom } : {}),
      ...(input.validTo !== undefined ? { validTo: input.validTo } : {}),
      ...(input.memo !== undefined ? { memo: input.memo } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
      ...(input.levyPct !== undefined ? { levyPct: input.levyPct } : {}),
    }),
  );
}

export async function deleteRateCard(id: string) {
  const card = await cardOr404(id);
  // Deactivate-instead, the same rule as service levels: a card that has
  // priced jobs, or would price this customer's delivered jobs still waiting to
  // be invoiced, is billing history. Disabling it stops it pricing anything new
  // and keeps every link intact; deleting is only for a card nothing used.
  const { invoiceLines, unbilledJobs } = await repo.countCardUsage(card);
  if (invoiceLines > 0 || unbilledJobs > 0) {
    const why = [
      invoiceLines > 0 ? `${invoiceLines} invoiced job${invoiceLines === 1 ? ' was' : 's were'} priced from it` : '',
      unbilledJobs > 0
        ? `${unbilledJobs} delivered job${unbilledJobs === 1 ? ' is' : 's are'} still waiting to be invoiced at its rates`
        : '',
    ]
      .filter(Boolean)
      .join(', and ');
    throw AppError.conflict(
      `${card.name} cannot be deleted: ${why}. Switch it to Disabled instead.`,
    );
  }
  // Rates and the customer's service prices cascade with the card.
  await repo.deleteCard(id);
}

/* ------------------------------------------------------------------ rates */

export async function listRouteRates(cardId: string, q: ListRatesQuery) {
  await cardOr404(cardId);
  const rows = await repo.listRates(cardId, {
    ...(q.serviceLevelId ? { serviceLevelId: q.serviceLevelId } : {}),
    ...(q.freightItemId ? { freightItemId: q.freightItemId } : {}),
  });
  return rows.map(toRateDto);
}

export async function putRouteRate(cardId: string, input: PutRouteRateInput) {
  const card = await cardOr404(cardId);

  const [serviceLevel, freightItem] = await Promise.all([
    repo.findServiceLevelById(input.serviceLevelId),
    repo.findFreightItemById(input.freightItemId),
  ]);
  if (!serviceLevel) throw AppError.badRequest('That service level does not exist');
  if (!freightItem) throw AppError.badRequest('That freight item does not exist');

  // The zone must come from THIS card's list. A zone off another customer's map
  // would price a destination that this card's own screen cannot even display.
  const found = await repo.countZonesInList(card.zoneListId, [input.toZoneId]);
  if (found !== 1) {
    throw AppError.badRequest(`That zone must belong to "${card.zoneList.name}"`);
  }

  return toRateDto(
    await repo.upsertRate(
      {
        rateCardId: cardId,
        serviceLevelId: input.serviceLevelId,
        freightItemId: input.freightItemId,
        toZoneId: input.toZoneId,
      },
      {
        baseRate: input.baseRate,
        freeKm: input.freeKm,
        ratePerKm: input.ratePerKm,
        freeWaitMinutes: input.freeWaitMinutes,
        waitRatePerMinute: input.waitRatePerMinute,
      },
    ),
  );
}

/* ----------------------------------------------- additional services */

/** Decimal-or-null to number-or-null. */
const maybe = (d: Prisma.Decimal | null) => (d === null ? null : Number(d.toString()));

function toServiceDto(row: repo.ServiceForCardRow) {
  const override = row.cardServices[0] ?? null;
  const defaultRate = maybe(row.defaultRate);
  const rate = override ? maybe(override.rate) : null;

  return {
    id: row.id,
    name: row.name,
    defaultRate,
    /**
     * Whether an operator picks this charge or the system applies it. The card
     * still prices both — an automatic charge can be negotiated like any other
     * — but only one of them belongs in a list of boxes to tick.
     */
    trigger: row.trigger,
    /** Null when this card charges the standard price. */
    override: override ? { rate } : null,
    /**
     * What this customer actually pays: their own price where there is one, the
     * catalogue default where there is not. The caller never re-applies the
     * fallback and so cannot apply it differently.
     */
    effective: { rate: rate ?? defaultRate },
  };
}

export async function listCardServices(cardId: string) {
  await cardOr404(cardId);
  const rows = await repo.listServicesForCard(cardId);
  return rows.map(toServiceDto);
}

/**
 * Price one service for this card — or, when the box is cleared, stop overriding
 * it. Deleting the row rather than storing a null keeps "same as standard" to a
 * single representation, so a later change to the catalogue default reaches this
 * card as it should.
 */
export async function putCardService(cardId: string, input: PutCardServiceInput) {
  await cardOr404(cardId);

  const service = await repo.findAdditionalServiceById(input.additionalServiceId);
  if (!service) throw AppError.badRequest('That additional service does not exist');

  const rate = input.rate ?? null;

  if (rate === null) {
    await repo.deleteCardService(cardId, input.additionalServiceId);
  } else {
    await repo.upsertCardService(cardId, input.additionalServiceId, { rate });
  }

  return listCardServices(cardId);
}

export async function removeCardService(cardId: string, serviceId: string) {
  await cardOr404(cardId);
  await repo.deleteCardService(cardId, serviceId);
  return listCardServices(cardId);
}

/* ------------------------------------------------------------------ quote */

/*
 * Pricing a hypothetical job against one card.
 *
 * Nothing is written and nothing is reserved — this answers "what would this
 * cost", which is a question an operator asks out loud a dozen times a day.
 *
 * Two kinds of "no" live here and they are deliberately different. A missing
 * service level is a **400**: the caller sent an id for something that does not
 * exist. A postcode outside the card's zone list, or a route the card never
 * priced, comes back **200 with `ok: false` and a sentence** — it is a real
 * answer about the price book, not a malformed request, and job pricing will
 * need exactly that distinction the day it can leave an order unpriced.
 */
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const dayOf = (d: Date) => d.toISOString().slice(0, 10);

export interface QuoteLine {
  key: string;
  label: string;
  /** The working behind the number, e.g. "412 km, 50 free x 1.85". */
  detail: string | null;
  amount: number;
}

function stopProblem(where: 'Pickup' | 'Delivery', raw: string, reason: string, listName: string) {
  return reason === 'INVALID_POSTAL_CODE'
    ? `${where} postcode "${raw}" is not a Canadian postcode`
    : `${where} postcode "${raw}" is not in the "${listName}" zone list`;
}

export async function quoteRateCard(cardId: string, input: QuoteInput) {
  const card = await cardOr404(cardId);

  const [serviceLevel, freightItem] = await Promise.all([
    repo.findServiceLevelById(input.serviceLevelId),
    input.freightItemId ? repo.findFreightItemById(input.freightItemId) : null,
  ]);
  if (!serviceLevel) throw AppError.badRequest('That service level does not exist');
  // A named item that does not exist is still a mistake worth refusing; an
  // unnamed one is the loose case and perfectly legitimate.
  if (input.freightItemId && !freightItem) {
    throw AppError.badRequest('That freight item does not exist');
  }

  const warnings: string[] = [];
  const on = input.on ?? new Date();
  if (!card.active) {
    warnings.push('This card is disabled, so a live job would not be priced from it.');
  } else if (on < card.validFrom || on > card.validTo) {
    warnings.push(
      `This card only covers ${dayOf(card.validFrom)} to ${dayOf(card.validTo)}, so it would not apply on ${dayOf(on)}.`,
    );
  }

  /*
   * Only the destination decides the price. A pickup postcode is still resolved
   * when one is given, because seeing which zone a collection fell in is useful
   * on the receipt — but nothing is looked up with it, and a job collected
   * outside every zone prices perfectly well.
   */
  const to = await zones.resolveZoneLoose(card.zoneListId, input.deliveryPostalCode);
  const from = input.pickupPostalCode
    ? await zones.resolveZoneLoose(card.zoneListId, input.pickupPostalCode)
    : null;

  const head = {
    card: {
      id: card.id,
      name: card.name,
      client: card.client,
      zoneList: card.zoneList,
      validFrom: card.validFrom,
      validTo: card.validTo,
      active: card.active,
      currency: card.currency,
    },
    serviceLevel,
    freightItem,
    from: from && from.ok ? { ...from, input: input.pickupPostalCode as string } : null,
    to: to.ok ? { ...to, input: input.deliveryPostalCode } : null,
    warnings,
  };

  if (!to.ok) {
    return {
      ...head,
      ok: false,
      problem: stopProblem('Delivery', input.deliveryPostalCode, to.reason, card.zoneList.name),
      rate: null,
      lines: [],
      subTotal: 0,
      total: 0,
    };
  }

  /*
   * Matching is loose by design. The exact row wins when there is one; failing
   * that, any rate into this zone on this service level will do, whatever it
   * says about freight. The item table is barely involved in pricing, so
   * refusing to quote over a missing freight item would withhold a price the
   * card plainly contains.
   *
   * What loose must never be is silent. Picking one of several possible rates
   * is a guess about money, so it says which one it took.
   */
  let rate = freightItem
    ? await repo.findRateByRoute({
        rateCardId: card.id,
        serviceLevelId: serviceLevel.id,
        freightItemId: freightItem.id,
        toZoneId: to.zoneId,
      })
    : null;

  if (!rate || !rate.active) {
    const candidates = await repo.findRatesForZone({
      rateCardId: card.id,
      serviceLevelId: serviceLevel.id,
      toZoneId: to.zoneId,
    });

    if (candidates.length > 0) {
      rate = candidates[0];
      if (freightItem) {
        warnings.push(
          `No rate for ${freightItem.name}, so the ${rate.freightItem.name} rate was used.`,
        );
      } else if (candidates.length > 1) {
        warnings.push(
          `No freight item was given and this card has ${candidates.length} rates to ${to.zoneName}; the ${rate.freightItem.name} rate was used.`,
        );
      }
    }
  }

  if (!rate || !rate.active) {
    const carrying = freightItem ? ` carrying ${freightItem.name}` : '';
    return {
      ...head,
      ok: false,
      problem: `This card has no rate to ${to.zoneName} on ${serviceLevel.name}${carrying}`,
      rate: null,
      lines: [],
      subTotal: 0,
      total: 0,
    };
  }

  const priced = toRateDto(rate);
  const lines: QuoteLine[] = [{ key: 'base', label: 'Base rate', detail: null, amount: priced.baseRate }];

  const billableKm = Math.max(0, input.distanceKm - priced.freeKm);
  lines.push({
    key: 'distance',
    label: 'Distance',
    detail: `${input.distanceKm} km, ${priced.freeKm} free x ${priced.ratePerKm}`,
    amount: round2(billableKm * priced.ratePerKm),
  });

  const billableMinutes = Math.max(0, input.waitMinutes - priced.freeWaitMinutes);
  lines.push({
    key: 'waiting',
    label: 'Waiting',
    detail: `${input.waitMinutes} min, ${priced.freeWaitMinutes} free x ${priced.waitRatePerMinute}`,
    amount: round2(billableMinutes * priced.waitRatePerMinute),
  });

  if (input.additionalServiceIds.length > 0) {
    const available = await listCardServices(card.id);
    for (const id of new Set(input.additionalServiceIds)) {
      const svc = available.find((s) => s.id === id);
      if (!svc) {
        warnings.push('One of the chosen extras is not on this card and was left out.');
        continue;
      }
      // A charge nobody has priced is listed at zero rather than dropped: the
      // operator asked for it, and a silent omission reads as "it is free".
      if (svc.effective.rate === null) {
        warnings.push(`"${svc.name}" has no price on this card or in the catalogue.`);
      }
      lines.push({
        key: `service:${svc.id}`,
        label: svc.name,
        detail: svc.override ? "this customer's price" : 'standard price',
        amount: svc.effective.rate ?? 0,
      });
    }
  }

  /*
   * The levy rides on the carriage only — base, distance and waiting, which is
   * what the invoice calls the Base Price. The additional services sit outside
   * it: they are already quoted at an agreed price, and levying them would
   * charge a percentage on a number the customer reads as final.
   */
  const levyPct = Number(card.levyPct);
  if (levyPct > 0) {
    const basePrice = round2(
      lines
        .filter((l) => l.key === 'base' || l.key === 'distance' || l.key === 'waiting')
        .reduce((sum, l) => sum + l.amount, 0),
    );
    lines.push({
      key: 'levy',
      label: `Levy ${levyPct}%`,
      detail: `${levyPct}% of ${basePrice.toFixed(2)} base price`,
      amount: round2((basePrice * levyPct) / 100),
    });
  }

  /*
   * Tax rides on everything above it — carriage, extras and levy alike — which
   * is the one place the ladder stops being additive and starts compounding.
   * Last, therefore, and never levied upon in return.
   */
  const taxPct = Number(input.taxPct ?? 0);
  const subTotal = round2(lines.reduce((sum, l) => sum + l.amount, 0));
  if (taxPct > 0) {
    lines.push({
      key: 'tax',
      label: 'Tax',
      detail: `${taxPct}% of ${subTotal.toFixed(2)} sub total`,
      amount: round2((subTotal * taxPct) / 100),
    });
  }

  return {
    ...head,
    ok: true,
    problem: null,
    rate: priced,
    lines,
    subTotal,
    total: round2(lines.reduce((sum, l) => sum + l.amount, 0)),
  };
}

export async function deleteRouteRate(cardId: string, rateId: string) {
  await cardOr404(cardId);
  const rate = await repo.findRateById(cardId, rateId);
  if (!rate) throw AppError.notFound('Rate not found');
  await repo.deleteRate(rateId);
}
