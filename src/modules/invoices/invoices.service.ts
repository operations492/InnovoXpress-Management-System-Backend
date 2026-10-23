import { AppError } from '../../utils/httpError.js';
import type { PreviewInvoiceInput } from '../../schemas/invoice.schema.js';
import * as repo from './invoices.repository.js';

/*
 * The test calculator. Given a client, a distance and a selection, it prices the
 * client's active rate plan and returns every line with the arithmetic that
 * produced it. Nothing is saved — this is a preview, not a document.
 *
 * Two rules worth knowing:
 *  - all arithmetic happens in integer cents and is rounded once per line, then
 *    summed. Round the total instead and the total stops matching the lines the
 *    customer is reading.
 *  - distance is charged in WHOLE blocks of `blockKm`, which the console pins to
 *    1 — so in practice a part km rounds up to a whole one. Every line carries a
 *    `note` showing that step, because this is the number customers argue about.
 */

/** Ontario HST. Kept out of the rates themselves so the invoice can show it. */
const TAX_RATE = 0.13;
const TAX_LABEL = 'HST (13%)';

type Line = {
  kind: 'BASE' | 'DISTANCE' | 'SERVICE_LEVEL' | 'ADDITIONAL_SERVICE' | 'FREIGHT_ITEM';
  label: string;
  qty?: number;
  unitPrice?: number;
  amount: number;
  note?: string;
};

const toCents = (d: unknown) => Math.round(Number(d) * 100);
const toMoney = (cents: number) => Math.round(cents) / 100;

export async function previewInvoice(input: PreviewInvoiceInput) {
  const client = await repo.findClient(input.clientId);
  if (!client) throw AppError.badRequest('Unknown client');

  const plan = await repo.findActivePlan(client.id);
  if (!plan) {
    throw AppError.conflict(`${client.name} has no active rate plan — create one first`);
  }

  const names = await repo.findNames({
    serviceLevelIds: input.serviceLevelId ? [input.serviceLevelId] : [],
    additionalServiceIds: input.additionalServiceIds,
    freightItemIds: input.freightItems.map((f) => f.id),
  });

  // A missing grid row means "not priced for this client"; a row at 0 means
  // deliberately free. Only the first earns a warning.
  const priced = {
    serviceLevel: new Map<string, number>(),
    additionalService: new Map<string, number>(),
    freightItem: new Map<string, number>(),
  };
  for (const i of plan.items) {
    if (i.serviceLevelId) priced.serviceLevel.set(i.serviceLevelId, toCents(i.price));
    if (i.additionalServiceId) priced.additionalService.set(i.additionalServiceId, toCents(i.price));
    if (i.freightItemId) priced.freightItem.set(i.freightItemId, toCents(i.price));
  }

  const lines: Line[] = [];
  const warnings: string[] = [];

  // --- base rate -----------------------------------------------------------
  const baseCents = toCents(plan.baseRate);
  lines.push({
    kind: 'BASE',
    label:
      plan.includedKm > 0
        ? `Base rate (first ${plan.includedKm} km)`
        : 'Base rate',
    amount: toMoney(baseCents),
  });
  if (baseCents === 0 && toCents(plan.blockRate) === 0) {
    warnings.push(`Plan "${plan.name}" has no base rate or distance rate configured`);
  }

  // --- distance beyond the included allowance ------------------------------
  const beyondKm = Math.max(0, input.distanceKm - plan.includedKm);
  if (beyondKm > 0) {
    const exactBlocks = beyondKm / plan.blockKm;
    const blocks = Math.ceil(exactBlocks);
    const blockCents = toCents(plan.blockRate);
    // A block of 1 km is the only thing the console configures, and "3 × 1 km
    // block" is a sentence no customer should have to read.
    const perKm = plan.blockKm === 1;
    lines.push({
      kind: 'DISTANCE',
      label: perKm
        ? `${blocks} km beyond ${plan.includedKm} km`
        : `${blocks} × ${plan.blockKm} km block beyond ${plan.includedKm} km`,
      qty: blocks,
      unitPrice: toMoney(blockCents),
      amount: toMoney(blocks * blockCents),
      note: perKm
        ? `${input.distanceKm} km → ${Number(beyondKm.toFixed(2))} km beyond included, ` +
          `charged as ${blocks} whole km`
        : `${input.distanceKm} km → ${Number(beyondKm.toFixed(2))} km beyond included → ` +
          `${Number(exactBlocks.toFixed(2))} blocks, charged as ${blocks} whole`,
    });
  }

  // --- service level -------------------------------------------------------
  if (input.serviceLevelId) {
    const label = names.serviceLevels.get(input.serviceLevelId);
    if (!label) throw AppError.badRequest(`Unknown serviceLevelId: ${input.serviceLevelId}`);
    const cents = priced.serviceLevel.get(input.serviceLevelId);
    if (cents === undefined) {
      warnings.push(`"${label}" has no price in this plan — charged as 0`);
    }
    lines.push({ kind: 'SERVICE_LEVEL', label, amount: toMoney(cents ?? 0) });
  }

  // --- additional services -------------------------------------------------
  for (const id of new Set(input.additionalServiceIds)) {
    const label = names.additionalServices.get(id);
    if (!label) throw AppError.badRequest(`Unknown additionalServiceId: ${id}`);
    const cents = priced.additionalService.get(id);
    if (cents === undefined) {
      warnings.push(`"${label}" has no price in this plan — charged as 0`);
    }
    lines.push({ kind: 'ADDITIONAL_SERVICE', label, amount: toMoney(cents ?? 0) });
  }

  // --- freight items, priced per unit --------------------------------------
  for (const f of input.freightItems) {
    const label = names.freightItems.get(f.id);
    if (!label) throw AppError.badRequest(`Unknown freight item: ${f.id}`);
    const cents = priced.freightItem.get(f.id);
    if (cents === undefined) {
      warnings.push(`"${label}" has no price in this plan — charged as 0`);
    }
    const unit = cents ?? 0;
    lines.push({
      kind: 'FREIGHT_ITEM',
      label: `${label} × ${f.qty}`,
      qty: f.qty,
      unitPrice: toMoney(unit),
      amount: toMoney(unit * f.qty),
    });
  }

  // Sum the rounded lines, never the raw cents, so the total matches what is printed.
  const subtotalCents = lines.reduce((sum, l) => sum + Math.round(l.amount * 100), 0);
  const taxCents = Math.round(subtotalCents * TAX_RATE);

  return {
    client,
    ratePlan: { id: plan.id, name: plan.name },
    currency: plan.currency,
    distanceKm: input.distanceKm,
    basis: {
      baseRate: toMoney(baseCents),
      includedKm: plan.includedKm,
      blockKm: plan.blockKm,
      blockRate: toMoney(toCents(plan.blockRate)),
    },
    lines,
    subtotal: toMoney(subtotalCents),
    tax: { label: TAX_LABEL, rate: TAX_RATE, amount: toMoney(taxCents) },
    total: toMoney(subtotalCents + taxCents),
    warnings,
    /** Nothing was saved. Pricing a real order will snapshot these amounts onto it. */
    preview: true,
  };
}
