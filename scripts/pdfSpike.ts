/**
 * Spike: can pdfkit + bwip-js reproduce the print pack (label, POD sheet,
 * receiver's copy) straight from a consignment row, with no browser involved?
 *
 *   npx tsx scripts/pdfSpike.ts [ORDER_NO] [OUT_PATH]
 *
 * Throwaway. If the output is good enough this becomes a `documents` module
 * with an endpoint per sheet; if not, the alternative is HTML → headless Chrome.
 */
import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import bwipjs from 'bwip-js';
import { prisma } from '../src/config/prisma.js';

const COMPANY = {
  name: 'Innovo Xpress Inc',
  line1: '6660 Kennedy Road',
  line2: 'Unit 23',
  city: 'Mississauga ON L5T 2M9',
  email: 'dispatch@innovoxpress.com',
  phone: '905-674-0666',
};

const NAVY = '#1A1A6E';
const ORANGE = '#F5A623';
const INK = '#111111';
const MUTED = '#555555';
const RULE = '#222222';

type Order = NonNullable<Awaited<ReturnType<typeof loadOrder>>>;

async function loadOrder(orderNo?: string) {
  return prisma.consignment.findFirst({
    where: orderNo ? { orderNo } : { orderNo: { startsWith: 'BLD-' } },
    orderBy: { orderNo: 'asc' },
    include: {
      client: { select: { name: true, code: true } },
      driver: { select: { name: true } },
      items: { orderBy: { createdAt: 'asc' } },
    },
  });
}

async function barcode(text: string, opts: { scale?: number; height?: number } = {}) {
  return bwipjs.toBuffer({
    bcid: 'code128',
    text,
    scale: opts.scale ?? 3,
    height: opts.height ?? 10,
    includetext: true,
    textxalign: 'center',
    textsize: 9,
  });
}

function fmtDateTime(d: Date): string {
  const date = d.toISOString().slice(0, 10);
  let h = d.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${date} ${h}:${String(d.getMinutes()).padStart(2, '0')} ${ampm}`;
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function num(v: unknown): number {
  return v == null ? 0 : Number(v);
}

/* ------------------------------------------------------------------ label */

function drawLabel(doc: PDFKit.PDFDocument, o: Order, code: Buffer) {
  const W = 288; // 4in
  const m = 18;
  doc.addPage({ size: [W, 432], margin: m });

  doc.fillColor(INK).font('Helvetica-Bold').fontSize(8).text('Receiver:', m, m);
  doc.font('Helvetica-Bold').fontSize(12).text(o.receiverName.toUpperCase(), m, m + 12, { width: W - 2 * m });
  doc.font('Helvetica').fontSize(11).text(o.receiverLine1, { width: W - 2 * m });

  doc.moveDown(0.6);
  doc.font('Helvetica').fontSize(18).text(o.receiverCity, m, doc.y, { width: W - 2 * m });
  const y = doc.y;
  doc.font('Helvetica').fontSize(22).text(`${o.receiverProvince ?? ''}, ${o.receiverPostcode ?? ''}`, m, y, {
    width: W - 2 * m - 60,
  });
  doc.fontSize(20).text('1 / 1', W - m - 60, y, { width: 60, align: 'right' });

  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(8).fillColor(MUTED);
  const ref = [o.receiverPhone, o.clientReference].filter(Boolean).join('  ·  ');
  if (ref) doc.text(ref, m, doc.y, { width: W - 2 * m });

  const bw = 200;
  doc.image(code, (W - bw) / 2, 250, { width: bw });
}

/* ------------------------------------------------------------------ sheet */

function drawSheet(doc: PDFKit.PDFDocument, o: Order, code: Buffer, title: string) {
  const W = 612;
  const m = 36;
  const right = W - m;
  doc.addPage({ size: 'LETTER', margin: m });

  // Header: wordmark, title, service + date + barcode.
  doc.font('Helvetica-Bold').fontSize(20).fillColor(NAVY).text('INN', m, m + 6, { continued: true });
  doc.fillColor(ORANGE).text('O', { continued: true });
  doc.fillColor(NAVY).text('VO');
  doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text(title, 0, m + 12, { width: W, align: 'center' });

  const service = o.priority === 'HIGH' ? 'Priority - Car' : 'Standard - Car';
  doc.font('Helvetica-Bold').fontSize(8).text(service, right - 210, m + 4, { width: 110, align: 'right' });
  doc.font('Helvetica').fontSize(8).text(fmtDate(o.pickupAfter), right - 90, m + 4, { width: 90, align: 'right' });
  doc.image(code, right - 150, m + 16, { width: 150 });

  let y = m + 66;
  doc.moveTo(m, y).lineTo(right, y).lineWidth(1.2).strokeColor(RULE).stroke();
  y += 6;

  // Sender / receiver columns.
  const colW = (W - 2 * m) / 2;
  const party = (
    x: number,
    label: string,
    name: string,
    line1: string,
    cityLine: string,
    phone: string | null,
    refLabel: string,
    ref: string | null,
  ) => {
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(label, x, y);
    doc.font('Helvetica-Bold').fontSize(8).fillColor(INK).text(name.toUpperCase(), x, y + 10);
    doc.font('Helvetica-Bold').text(line1, x, y + 20);
    doc.text(cityLine, x, y + 34);
    doc.font('Helvetica').text(phone ?? '', x, y + 46);
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(`${refLabel}: `, x, y + 60, { continued: true });
    doc.fillColor(INK).text(ref ?? '');
  };
  party(
    m,
    'Sender',
    o.senderName,
    o.senderLine1,
    `${o.senderCity} ${o.senderProvince ?? ''}, ${o.senderPostcode ?? ''}`,
    o.senderPhone,
    'Sender Reference',
    o.clientReference,
  );
  party(
    m + colW,
    'Receiver',
    o.receiverName,
    o.receiverLine1,
    `${o.receiverCity} ${o.receiverProvince ?? ''}, ${o.receiverPostcode ?? ''}`,
    o.receiverPhone,
    'Receiver Reference',
    null,
  );
  y += 82;

  // Ready / dangerous goods / booking, then instructions.
  doc.font('Helvetica').fontSize(8).fillColor(INK);
  doc.text(`Ready: ${fmtDateTime(o.pickupAfter)}`, m, y);
  doc.text('Dangerous Goods', m + colW - 40, y);
  doc.text(`Booking: ${fmtDateTime(o.createdAt)}`, m + colW + 80, y);
  y += 12;
  doc.fillColor(MUTED).text('Instructions: ', m, y, { continued: true }).fillColor(INK).text(o.senderInstructions ?? '');
  doc.fillColor(MUTED).text('Instructions: ', m + colW + 80, y, { continued: true }).fillColor(INK).text(o.receiverNotes ?? '');
  y += 24;

  // Items table.
  const cols = [
    { label: 'Reference', x: m, w: 70 },
    { label: 'Quantity', x: m + 80, w: 50, align: 'center' as const },
    { label: 'Description', x: m + 140, w: 210 },
    { label: 'Weight', x: m + 360, w: 50, align: 'center' as const },
    { label: 'Length x Width x Height', x: m + 415, w: 90, align: 'center' as const },
    { label: 'Cubic', x: m + 505, w: 35, align: 'center' as const },
  ];
  doc.moveTo(m, y).lineTo(right, y).lineWidth(0.8).stroke();
  y += 4;
  doc.font('Helvetica').fontSize(7.5).fillColor(MUTED);
  for (const c of cols) doc.text(c.label, c.x, y, { width: c.w, align: c.align ?? 'left' });
  y += 12;
  doc.moveTo(m, y).lineTo(right, y).lineWidth(0.8).stroke();
  y += 4;

  doc.font('Helvetica').fontSize(8).fillColor(INK);
  let totalQty = 0;
  let totalWeight = 0;
  for (const it of o.items) {
    const w = num(it.weightKg) * it.qty;
    totalQty += it.qty;
    totalWeight += w;
    const cells = [it.barcode ?? '', String(it.qty), it.description, w ? w.toFixed(1) : '0', '0 x 0 x 0', '0'];
    cells.forEach((v, i) => {
      const c = cols[i]!;
      doc.text(v, c.x, y, { width: c.w, align: c.align ?? 'left' });
    });
    y += 13;
  }

  // Totals sit at a fixed height so both copies line up on the page.
  const totalsY = m + 380;
  doc.moveTo(m, totalsY).lineTo(right, totalsY).lineWidth(0.8).stroke();
  doc.font('Helvetica').fontSize(8).fillColor(INK);
  doc.text(`Total Qty ${totalQty}`, m + 60, totalsY + 4);
  doc.text(`Total Weight ${totalWeight.toFixed(1)}`, m + 300, totalsY + 4);
  doc.text('Total Cubic 0', m + 470, totalsY + 4);

  doc.text('Office Use', m + 100, totalsY + 22);
  doc.fontSize(7.5).text(
    'We are not COMMON CARRIERS. Insurance is not included unless otherwise stated.\nReceived in good order and condition.',
    m + 200,
    totalsY + 22,
    { width: 340, align: 'center' },
  );

  // Signature lines.
  const sigY = totalsY + 68;
  const sig = [
    { x: m + 220, w: 110, label: '(Received Date/Time)' },
    { x: m + 340, w: 110, label: '(Receiver Name)' },
    { x: m + 460, w: 80, label: '(Receiver Signature)' },
  ];
  for (const s of sig) {
    doc.moveTo(s.x, sigY).lineTo(s.x + s.w, sigY).lineWidth(0.5).dash(2, { space: 2 }).stroke().undash();
    doc.fontSize(6.5).fillColor(MUTED).text(s.label, s.x, sigY + 3, { width: s.w, align: 'center' });
  }

  // Footer.
  const footY = totalsY + 90;
  doc.moveTo(m, footY).lineTo(right, footY).lineWidth(0.5).dash(2, { space: 2 }).stroke().undash();
  doc.fontSize(7.5).fillColor(INK).text(o.orderNo, m, footY + 4);
  doc.text('Page 1 of 1', right - 80, footY + 4, { width: 80, align: 'right' });

  // Company block, as on the report cover.
  const coY = 700;
  doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(COMPANY.name, m, coY);
  doc.font('Helvetica').fontSize(7.5).text(`${COMPANY.line1}\n${COMPANY.line2}\n${COMPANY.city}\n${COMPANY.email}\n${COMPANY.phone}`, right - 150, coY, {
    width: 150,
    align: 'right',
  });
}

/* ------------------------------------------------------------------- main */

async function main() {
  const [orderNo, outArg] = process.argv.slice(2);
  const o = await loadOrder(orderNo);
  if (!o) throw new Error(`No consignment found${orderNo ? ` for ${orderNo}` : ''}`);

  const out = outArg ?? path.resolve('tmp', `${o.orderNo}.pdf`);
  fs.mkdirSync(path.dirname(out), { recursive: true });

  const labelCode = await barcode(o.orderNo, { scale: 3, height: 14 });
  const sheetCode = await barcode(o.orderNo, { scale: 2, height: 8 });

  const doc = new PDFDocument({ autoFirstPage: false, info: { Title: `${o.orderNo} print pack` } });
  const stream = fs.createWriteStream(out);
  doc.pipe(stream);

  drawLabel(doc, o, labelCode);
  drawSheet(doc, o, sheetCode, 'PROOF OF DELIVERY');
  drawSheet(doc, o, sheetCode, 'RECEIVERS COPY');

  doc.end();
  await new Promise<void>((resolve, reject) => {
    stream.on('finish', () => resolve());
    stream.on('error', reject);
  });

  const bytes = fs.statSync(out).size;
  console.log(`✓ ${o.orderNo} → ${out} (${(bytes / 1024).toFixed(1)} KB, 3 pages)`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
