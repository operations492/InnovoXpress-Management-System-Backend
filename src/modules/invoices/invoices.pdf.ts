import PDFDocument from 'pdfkit';
import { AppError } from '../../utils/httpError.js';
import {
  BILLING,
  BOLD,
  COMPANY,
  INK,
  MUTED,
  NAVY,
  REG,
  fmtDate,
  wordmark,
} from '../documents/documents.brand.js';
import { A4, flow, rule } from '../documents/documents.render.js';
import * as service from './invoices.service.js';

export interface RenderedPdf {
  filename: string;
  body: Buffer;
}

/*
 * The customer invoice.
 *
 * Built so every figure on it can be checked from the page alone. Each job
 * carries its own Base, Services, Levy, Tax and Total, with a line beneath
 * naming every charge that made them up — the same breakdown the console's
 * price pane shows — and the totals block lists Base, Services, each levy
 * rate, Sub total and Tax, so the columns visibly add up to the Grand total.
 *
 * Layout rules, each learned from a version that broke them:
 *  - Row height is MEASURED, never fixed. A fixed 26pt row with a three-line
 *    address put the last line on top of the separator rule.
 *  - Every column ends inside the right margin. The previous last column ran
 *    to the page edge and its amounts were clipped.
 *  - Body text is 8–9pt. The previous 6.5pt address lines were unreadable once
 *    printed.
 */

/* ------------------------------------------------------------- geometry */

const M = 40; // page margin
const RIGHT = A4[0] - M; // 555.28
const PAGE_BOTTOM = A4[1] - 48; // keep clear of the page-number footer
const LINE = 9.5; // one line of 8pt type, with leading

type Align = 'left' | 'right';

/**
 * Nine columns inside 515pt. Text columns are drawn 6pt narrower than their
 * slot so neighbouring cells never touch; money columns are right-aligned so
 * their decimal points line up.
 */
const COLS: Array<{ key: string; label: string; x: number; w: number; align: Align }> = [
  // 90pt: a full order number (IXD-20261104-0002) needs ~82pt in bold, and an
  // 74pt column wrapped its last digit onto the date below.
  { key: 'no', label: 'Consignment', x: M, w: 90, align: 'left' },
  { key: 'from', label: 'Sender', x: M + 90, w: 80, align: 'left' },
  { key: 'to', label: 'Receiver', x: M + 170, w: 98, align: 'left' },
  { key: 'qty', label: 'Qty', x: M + 268, w: 22, align: 'right' },
  // "Freight", not "Base": the breakdown below has a "Base rate" line, and the
  // same word for two different amounts read as a mismatch.
  { key: 'base', label: 'Freight', x: M + 290, w: 44, align: 'right' },
  { key: 'svc', label: 'Services', x: M + 334, w: 46, align: 'right' },
  { key: 'levy', label: 'Levy', x: M + 380, w: 42, align: 'right' },
  { key: 'tax', label: 'Tax', x: M + 422, w: 40, align: 'right' },
  { key: 'total', label: 'Total', x: M + 462, w: 52, align: 'right' },
];
const col = (key: string) => COLS.find((c) => c.key === key)!;

const money = (n: number) =>
  `$${n.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

type Invoice = Awaited<ReturnType<typeof service.getInvoice>>;
type Line = NonNullable<Invoice['lines']>[number];

/* ------------------------------------------------------------- helpers */

/** One line of text that never wraps; overlong text ends in an ellipsis. */
function one(
  doc: PDFKit.PDFDocument,
  text: string,
  x: number,
  y: number,
  w: number,
  size: number,
  font = REG,
  color = INK,
  align: Align = 'left',
) {
  doc.font(font).fontSize(size).fillColor(color);
  // `height` is what makes the ellipsis work. pdfkit wraps to `width` whatever
  // `lineBreak` says, and only truncates text that overflows a given height —
  // without it a long name wrapped onto, and printed over, the line below.
  doc.text(text, x, y, {
    width: w,
    height: size * 1.3,
    align,
    ellipsis: true,
    characterSpacing: 0,
  });
}

/*
 * Every charge on one job, one per line, grouped under the column it adds up
 * to — the way a receipt reads:
 *
 *     Freight                                        $47.50
 *         Base rate                        22.50
 *         Distance  7.03 km · first 15 km free · $1.65/km   0.00
 *         Waiting   35 min · first 15 min free · $1.25/min  25.00
 *     Services                                       $110.50
 *         Tailgate Service                 38.50
 *     Levy 27.5% of $47.50                            $13.06
 *     Tax 13% of $171.06                              $22.24
 *
 * Group amounts sit in their own column to the right of the item amounts, so
 * the eye can add the items and land on the group, then match the group to
 * the column above.
 */
interface BRow {
  level: 0 | 1;
  label: string;
  detail?: string;
  amount: number;
  /** For a group: the table column its amount sits under, so it lines up with it. */
  col?: 'base' | 'svc' | 'levy' | 'tax';
}

const GROUP_H = 11;
const ITEM_H = 9.5;
const BX = M + 12; // group label
const IX = M + 26; // item label
const ITEM_END = M + 268; // right edge of item amounts; group amounts use their column

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The quote engine writes "7.03 km, 15 free x 1.65". Reworded for a customer:
 * "7.03 km · first 15 km free · $1.65/km". Anything else passes through.
 */
function friendly(detail: string | null): string | undefined {
  if (!detail) return undefined;
  const km = /^([\d.]+) km, ([\d.]+) free x ([\d.]+)$/.exec(detail);
  if (km) return `${km[1]} km · first ${km[2]} km free · $${Number(km[3]).toFixed(2)}/km`;
  const min = /^(\d+) min, (\d+) free x ([\d.]+)$/.exec(detail);
  if (min) return `${min[1]} min · first ${min[2]} min free · $${Number(min[3]).toFixed(2)}/min`;
  return detail === 'edited by hand' || detail === 'added by hand' ? detail : undefined;
}

function breakdownRows(line: Line, taxPct: number): BRow[] {
  const rows: BRow[] = [];

  rows.push({ level: 0, label: 'Freight', amount: line.baseAmount, col: 'base' });
  for (const p of line.priceLines.filter((x) => ['BASE', 'DISTANCE', 'WAITING'].includes(x.kind))) {
    rows.push({
      level: 1,
      label: p.kind === 'BASE' ? 'Base rate' : p.label,
      detail: friendly(p.detail),
      amount: p.amount,
    });
  }

  const services = line.priceLines.filter((x) => x.kind === 'SERVICE' || x.kind === 'MANUAL');
  if (services.length > 0 || line.serviceAmount !== 0) {
    rows.push({ level: 0, label: 'Services', amount: line.serviceAmount, col: 'svc' });
    for (const p of services) {
      rows.push({
        level: 1,
        label: p.label,
        // "this customer's price" is noise to the customer; a hand edit is not.
        detail: p.kind === 'MANUAL' ? 'added by hand' : p.detail === 'edited by hand' ? 'edited by hand' : undefined,
        amount: p.amount,
      });
    }
  }

  if (line.levyPct > 0 || line.levyAmount !== 0) {
    rows.push({
      level: 0,
      label: `Levy ${line.levyPct}% of ${money(line.baseAmount)}`,
      amount: line.levyAmount,
      col: 'levy',
    });
  }

  const sub = round2(line.baseAmount + line.serviceAmount + line.levyAmount);
  rows.push({
    level: 0,
    label: taxPct > 0 ? `Tax ${taxPct}% of ${money(sub)}` : 'Tax (exempt)',
    amount: line.taxAmount,
    col: 'tax',
  });

  return rows;
}

const breakdownHeight = (rows: BRow[]) => rows.reduce((h, r) => h + (r.level === 0 ? GROUP_H : ITEM_H), 0);

function drawBreakdown(doc: PDFKit.PDFDocument, rows: BRow[], y: number) {
  let cy = y;
  for (const r of rows) {
    if (r.level === 0) {
      // Group headings carry no amount: the job row above already shows each
      // group's figure in its own column, so repeating it here was noise.
      one(doc, r.label, BX, cy, ITEM_END - BX, 8, BOLD, INK);
      cy += GROUP_H;
    } else {
      doc.font(REG).fontSize(7.5);
      const labelW = Math.min(doc.widthOfString(r.label), 120);
      one(doc, r.label, IX, cy, labelW + 2, 7.5, REG, INK);
      if (r.detail) {
        const dx = IX + labelW + 8;
        one(doc, r.detail, dx, cy, ITEM_END - 56 - dx, 7, REG, MUTED);
      }
      one(doc, money(r.amount), ITEM_END - 54, cy, 54, 7.5, REG, INK, 'right');
      cy += ITEM_H;
    }
  }
}

/* ----------------------------------------------------------------- page */

function letterhead(doc: PDFKit.PDFDocument, inv: Invoice): number {
  wordmark(doc, M, M, 22);

  flow(doc, 'Invoice', RIGHT - 200, M - 2, 200, 22, BOLD, NAVY, 'right');
  flow(doc, `Tax Number: ${BILLING.taxNumber}`, RIGHT - 260, M + 26, 260, 8, REG, MUTED, 'right');

  // Issuer, right.
  let iy = M + 42;
  for (const l of [COMPANY.name, COMPANY.line1, COMPANY.city]) {
    iy = flow(doc, l, RIGHT - 260, iy, 260, 9, REG, INK, 'right');
  }

  // Bill-to, left.
  let by = M + 52;
  by = flow(doc, 'BILL TO', M, by, 260, 7, BOLD, MUTED);
  by = flow(doc, inv.billTo.name, M, by + 2, 260, 12, BOLD, NAVY);
  if (inv.billTo.line1) by = flow(doc, inv.billTo.line1, M, by + 1, 260, 9, REG, INK);
  if (inv.billTo.cityLine) by = flow(doc, inv.billTo.cityLine, M, by, 260, 9, REG, INK);

  // Invoice facts, right, label : value.
  let my = Math.max(iy, by) + 14;
  const facts: [string, string][] = [
    ['Invoice Number', inv.number],
    ['Invoice Date', fmtDate(new Date(inv.invoiceDate))],
    ['Due Date', fmtDate(new Date(inv.dueDate))],
  ];
  for (const [k, v] of facts) {
    one(doc, k, RIGHT - 230, my, 120, 9, BOLD, NAVY);
    one(doc, v, RIGHT - 110, my, 110, 9, REG, INK, 'right');
    my += 13;
  }

  return Math.max(my, by) + 14;
}

function columnHeads(doc: PDFKit.PDFDocument, y: number): number {
  for (const c of COLS) {
    one(doc, c.label, c.x, y, c.align === 'left' ? c.w - 6 : c.w, 7.5, BOLD, NAVY, c.align);
  }
  rule(doc, M, y + 12, RIGHT, 0.8);
  return y + 18;
}

/**
 * A name may wrap to two lines, never more. Names are what a customer checks a
 * row against, so cutting "Coverdale Clinic — Streetsville" to one line lost
 * the part that told two clinics apart.
 */
const NAME_SIZE = 8;
const NAME_MAX = NAME_SIZE * 1.25 * 2;
function nameHeight(doc: PDFKit.PDFDocument, text: string, w: number): number {
  doc.font(BOLD).fontSize(NAME_SIZE);
  return Math.min(doc.heightOfString(text, { width: w }), NAME_MAX);
}

/** How tall one job's block will be, so the page break is decided before drawing. */
function measureRow(doc: PDFKit.PDFDocument, line: Line, taxPct: number) {
  const c = line.consignment;
  const fromName = nameHeight(doc, c.sender.name, col('from').w - 6);
  const toName = nameHeight(doc, c.receiver.name, col('to').w - 6);
  const main = Math.max(
    LINE * 2, // order number + date
    fromName + LINE, // sender name + city
    toName + LINE * 2, // receiver name + street + city
  );
  const rows = breakdownRows(line, taxPct);
  const breakdown = breakdownHeight(rows);
  return { main, fromName, toName, rows, breakdown, total: main + 5 + breakdown + 8 };
}

/** A name in bold, wrapping to at most two lines, ellipsis past that. */
function name(doc: PDFKit.PDFDocument, text: string, x: number, y: number, w: number) {
  doc.font(BOLD).fontSize(NAME_SIZE).fillColor(INK);
  doc.text(text, x, y, { width: w, height: NAME_MAX, ellipsis: true, characterSpacing: 0 });
}

function drawRow(doc: PDFKit.PDFDocument, line: Line, y: number, h: ReturnType<typeof measureRow>) {
  const c = line.consignment;

  // Consignment number, then the delivery date under it.
  const no = col('no');
  one(doc, c.orderNo, no.x, y, no.w - 6, 8, BOLD, INK);
  one(doc, fmtDate(new Date(c.deliveredAt ?? c.date)), no.x, y + LINE, no.w - 6, 7.5, REG, MUTED);

  // Sender: who and which city — the street is the customer's own depot and
  // repeats on every row, so it is left to the bill-to block.
  const from = col('from');
  name(doc, c.sender.name, from.x, y, from.w - 6);
  one(
    doc,
    [c.sender.city, c.sender.province].filter(Boolean).join(' '),
    from.x,
    y + h.fromName,
    from.w - 6,
    7.5,
    REG,
    MUTED,
  );

  // Receiver: who, the street, and the city — what a customer checks against.
  const to = col('to');
  name(doc, c.receiver.name, to.x, y, to.w - 6);
  one(doc, c.receiver.line1, to.x, y + h.toName, to.w - 6, 7.5, REG, MUTED);
  one(
    doc,
    [c.receiver.city, c.receiver.postcode, c.receiver.province].filter(Boolean).join(' '),
    to.x,
    y + h.toName + LINE,
    to.w - 6,
    7.5,
    REG,
    MUTED,
  );

  const qty = col('qty');
  one(doc, String(c.qty), qty.x, y, qty.w, 8, REG, INK, 'right');

  const amounts: [string, number, boolean][] = [
    ['base', line.baseAmount, false],
    ['svc', line.serviceAmount, false],
    ['levy', line.levyAmount, false],
    ['tax', line.taxAmount, false],
    ['total', line.grandTotal, true],
  ];
  for (const [key, amount, strong] of amounts) {
    const k = col(key);
    one(doc, money(amount), k.x, y, k.w, 8, strong ? BOLD : REG, INK, 'right');
  }

  // Every charge on the job, one per line, so each column above can be checked.
  drawBreakdown(doc, h.rows, y + h.main + 5);

  rule(doc, M, y + h.total - 5, RIGHT, 0.3, true);
}

function totals(doc: PDFKit.PDFDocument, inv: Invoice, y: number): number {
  const lx = RIGHT - 240;
  const vx = RIGHT - 100;
  let cy = y;

  const row = (label: string, value: string, strong = false, size = 9) => {
    one(doc, label, lx, cy, 140, size, strong ? BOLD : REG, strong ? NAVY : INK);
    one(doc, value, vx, cy, 100, size, strong ? BOLD : REG, INK, 'right');
    cy += size + 5;
  };

  /*
   * The same buckets as the columns, in the same order, so the reader can add
   * down the page: Base + Services + Levy = Sub total; Sub total + Tax =
   * Grand total. Levies stay one line per rate, because jobs priced on cards
   * with different levies cannot share one percentage.
   */
  row(`Freight (${inv.lines?.length ?? 0} consignment${inv.lines?.length === 1 ? '' : 's'})`, money(inv.baseTotal));
  row('Additional services', money(inv.serviceTotal));
  if ((inv.levyBreakdown ?? []).length === 0) row('Levy', money(0));
  for (const l of inv.levyBreakdown ?? []) row(l.label, money(l.amount));

  cy += 2;
  rule(doc, lx, cy - 3, RIGHT, 0.5);
  row('Sub total', money(inv.baseTotal + inv.serviceTotal + inv.levyTotal), true);
  row(inv.taxPct > 0 ? `Tax ${inv.taxPct}%` : 'Tax (exempt)', money(inv.taxTotal));

  cy += 3;
  rule(doc, lx, cy - 3, RIGHT, 1);
  row('Grand total', money(inv.grandTotal), true, 11);

  return cy;
}

function remittance(doc: PDFKit.PDFDocument, y: number): number {
  let cy = y;
  cy = flow(doc, `Payment Terms: ${BILLING.paymentTerms}`, M, cy, 320, 9, BOLD, NAVY);
  cy += 6;
  cy = flow(doc, 'Payment methods:', M, cy, 320, 9, BOLD, NAVY);
  cy += 3;
  cy = flow(doc, '1. Direct Deposit', M, cy, 320, 8.5, BOLD, INK);
  for (const l of BILLING.bank) cy = flow(doc, l, M + 10, cy, 320, 8.5, REG, INK);
  cy += 3;
  cy = flow(doc, `2. E-transfer to ${BILLING.etransfer}`, M, cy, 320, 8.5, BOLD, INK);
  cy += 10;
  cy = flow(doc, BILLING.thanks, M, cy, RIGHT - M, 8, REG, MUTED);
  cy = flow(
    doc,
    `You can email us at ${BILLING.billingEmail}, and we will be happy to assist you promptly.`,
    M,
    cy,
    RIGHT - M,
    8,
    REG,
    MUTED,
  );
  return cy;
}

/** Height the remittance block needs, so it is never split across pages. */
const REMITTANCE_H = 150;
const TOTALS_H = 130;

export function drawInvoice(doc: PDFKit.PDFDocument, inv: Invoice) {
  const rows = inv.lines ?? [];

  doc.addPage({ size: A4, margin: 0 });
  let y = columnHeads(doc, letterhead(doc, inv));

  const newPage = () => {
    doc.addPage({ size: A4, margin: 0 });
    one(doc, `Invoice ${inv.number} — continued`, M, M - 8, 300, 8, BOLD, NAVY);
    return columnHeads(doc, M + 8);
  };

  for (const line of rows) {
    const h = measureRow(doc, line, inv.taxPct);
    if (y + h.total > PAGE_BOTTOM) y = newPage();
    drawRow(doc, line, y, h);
    y += h.total;
  }

  if (rows.length === 0) {
    y = flow(doc, 'No consignments on this invoice.', M, y + 4, 300, 9, REG, MUTED) + 8;
  }

  // Totals and remittance each stay whole: a Grand total stranded alone at the
  // top of a page, or bank details split over two, is how a payment goes wrong.
  y += 8;
  if (y + TOTALS_H > PAGE_BOTTOM) y = newPage() + 8;
  y = totals(doc, inv, y) + 18;

  if (y + REMITTANCE_H > PAGE_BOTTOM) {
    doc.addPage({ size: A4, margin: 0 });
    y = M;
  }
  remittance(doc, y);

  // "Page n of N" on every page, written once the total is known.
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    one(doc, `Page ${i + 1} of ${range.count}`, RIGHT - 120, A4[1] - 30, 120, 8, REG, MUTED, 'right');
    one(doc, `Invoice ${inv.number}`, M, A4[1] - 30, 200, 8, REG, MUTED);
  }
}

/* ----------------------------------------------------------------- build */

function collect(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

export async function invoicePdf(id: string): Promise<RenderedPdf> {
  const inv = await service.getInvoice(id);
  if (!inv) throw AppError.notFound('Invoice not found');

  // bufferPages so the footer can say "of N" — N is only known at the end.
  const doc = new PDFDocument({
    autoFirstPage: false,
    bufferPages: true,
    info: { Title: `Invoice ${inv.number}` },
  });
  drawInvoice(doc, inv);
  return { filename: `invoice-${inv.number}.pdf`, body: await collect(doc) };
}
