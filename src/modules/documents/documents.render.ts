/**
 * The three printed documents, drawn with pdfkit. No database, no I/O — a row,
 * a barcode buffer and any images in, a PDF out, which makes the layout testable.
 *
 * The label reproduces the 4x6 carrier label measured off the reference sheet,
 * coordinate for coordinate. The docket reproduces that sheet's field set and
 * arrangement two-up on A4; its exact coordinates were not recoverable from the
 * reference, so the ordering is faithful and the geometry is ours.
 *
 * The POD report reproduces the reference's proof sheet: one block per stop with
 * the signature, the signatory and the coordinate, then the photographs three to
 * a page. It is the one document gated on status — see `drawPodReport`.
 *
 * Deliberate departures from the reference, all defects or costs there:
 *   - the receiver line WRAPS instead of running off the label edge,
 *   - the barcode is 150pt wide, not 78pt, so it still scans at 4in,
 *   - each POD stop block names its leg; the reference's two blocks are
 *     indistinguishable,
 *   - the POD coordinate prints as numbers, not as a per-image map raster,
 *   - `DGS` prints blank rather than the reference's unsupported "No".
 */
import {
  BOLD,
  COMPANY,
  INK,
  MUTED,
  NAVY,
  ORANGE,
  REG,
  RULE,
  cityLine,
  cubicOf,
  fmtDate,
  fmtDateTime,
  fmtTime,
  num,
  totalsOf,
  wordmark,
} from './documents.brand.js';
import type { PrintableConsignment } from './documents.repository.js';

export const A4: [number, number] = [595.28, 841.89];
const LABEL: [number, number] = [288, 432];
/** Two copies per A4, receiver's and sender's. */
const COPY_H = 412;

/**
 * Writes text in a box and reports the baseline after it, so a long value pushes
 * the next line down instead of overprinting it.
 *
 * `characterSpacing: 0` is not decoration: the wordmark sets a wide spacing, and
 * pdfkit carries that into later calls, which silently widened every string until
 * words fell off the edge of the label.
 */
function flow(
  doc: PDFKit.PDFDocument,
  text: string,
  x: number,
  y: number,
  width: number,
  size: number,
  font = REG,
  color = INK,
  align: 'left' | 'center' | 'right' = 'left',
): number {
  doc.font(font).fontSize(size).fillColor(color);
  doc.text(text, x, y, { width, align, characterSpacing: 0 });
  return doc.y;
}

/** One cell of a table row: never wraps, never pushes the row height. */
function cell(
  doc: PDFKit.PDFDocument,
  text: string,
  x: number,
  y: number,
  width: number,
  size: number,
  align: 'left' | 'center' | 'right' = 'left',
) {
  doc.font(REG).fontSize(size).fillColor(INK);
  doc.text(text, x, y, { width, align, characterSpacing: 0, lineBreak: false, ellipsis: true });
}

function rule(doc: PDFKit.PDFDocument, x1: number, y: number, x2: number, w = 0.8, dashed = false) {
  doc.moveTo(x1, y).lineTo(x2, y).lineWidth(w).strokeColor(RULE);
  if (dashed) doc.dash(2, { space: 2 }).stroke().undash();
  else doc.stroke();
}

function serviceOf(o: PrintableConsignment): string {
  return o.serviceLevel?.name ?? 'Standard';
}

/* ------------------------------------------------------------------- label */

/**
 * One 4x6 label. `piece` is 1-based; `pieces` is the total so the label can say
 * "3 / 8" the way the warehouse counts cartons off a pallet.
 */
export function drawLabel(
  doc: PDFKit.PDFDocument,
  o: PrintableConsignment,
  code: Buffer,
  codeText: string,
  piece: number,
  pieces: number,
) {
  doc.addPage({ size: LABEL, margin: 0 });

  doc.lineWidth(0.8).strokeColor(RULE).rect(14, 14, 259.6, 403.6).stroke();

  wordmark(doc, 20, 24, 19);

  // Date / consignment number / service, stacked top-right. Flowed rather than
  // pinned: an Innovo order number is 17 characters where the reference's was 7.
  const rx = 118;
  const rw = 150;
  let ry = flow(doc, fmtDate(o.createdAt), rx, 22, rw, 11.5, REG, INK, 'center');
  ry = flow(doc, `CN: ${o.orderNo}`, rx, ry, rw, 9.5, BOLD, INK, 'center');
  flow(doc, serviceOf(o), rx, ry + 1, rw, 10, REG, INK, 'center');

  flow(doc, 'Sender:', 21, 78, 100, 7.7, BOLD);
  let y = flow(doc, o.senderName.toUpperCase(), 21, 89, 240, 7.7);
  y = flow(doc, o.senderLine1, 21, Math.max(y, 96), 240, 7.7);
  y = flow(doc, cityLine(o.senderCity, o.senderProvince, o.senderPostcode), 21, Math.max(y, 105), 240, 7.7);
  // The reference prints the sender's phone here; whoever is collecting needs a
  // number to ring when nobody answers the door.
  flow(doc, o.senderPhone ?? '', 21, Math.max(y, 114), 240, 7.7, REG, MUTED);

  flow(doc, 'Special Instructions:', 21, 138, 240, 7.7, BOLD);
  flow(doc, o.senderInstructions ?? '', 21, 148, 240, 7.7, REG, MUTED);

  flow(doc, 'Receiver:', 21, 174, 100, 7.7, BOLD);
  y = flow(doc, o.receiverName.toUpperCase(), 22, 186, 244, 13.4);
  flow(doc, o.receiverLine1, 22, Math.max(y, 199), 244, 13.4);

  flow(doc, o.receiverCity, 23, 234, 244, 19.1);
  const tail = [o.receiverProvince, o.receiverPostcode].filter(Boolean).join(', ');
  flow(doc, tail, 24, 261, 170, 23);
  flow(doc, `${piece} / ${pieces}`, 196, 261, 72, 23, REG, INK, 'right');

  const contact = [o.receiverPhone, o.receiverNotes].filter(Boolean).join('  ·  ');
  flow(doc, contact, 21, 291, 240, 7.7, REG, MUTED);

  // Bars, then the human-readable number underneath — a scanner reads one, a
  // person reads the other, and on a scuffed label the second is the fallback.
  doc.image(code, (LABEL[0] - 150) / 2, 332, { width: 150, height: 42 });
  flow(doc, codeText, 19, 376, 250, 7.8, BOLD, INK, 'center');
}

/* ------------------------------------------------------------------ docket */

function drawDocketCopy(
  doc: PDFKit.PDFDocument,
  o: PrintableConsignment,
  oy: number,
  copyLabel: string,
  code: Buffer,
) {
  const m = 20;
  const right = A4[0] - m;
  const colR = 300;

  wordmark(doc, m, oy + 18, 15);
  flow(doc, 'PROOF OF DELIVERY', 0, oy + 22, A4[0], 11, BOLD, INK, 'center');
  flow(doc, serviceOf(o), 380, oy + 22, 120, 8, BOLD, INK, 'right');
  flow(doc, fmtDate(o.createdAt), 505, oy + 22, 70, 8, REG, INK, 'right');
  flow(doc, o.orderNo, 300, oy + 40, 145, 9, BOLD, NAVY, 'right');
  // Each copy carries its own barcode, as the reference sheet does. Shorter than
  // the label's 150pt because it has to sit in the header band above the rule —
  // this sheet is scanned at a desk, not read off a carton across a warehouse.
  doc.image(code, 455, oy + 34, { width: 120, height: 22 });

  rule(doc, m, oy + 58, right, 1.2);

  // Sender and receiver, side by side. Every slot the reference prints is printed
  // here, including the ones we have no column for — a labelled blank is the
  // reference's own behaviour, and it tells the reader the field exists.
  const party = (
    x: number,
    label: string,
    name: string,
    line1: string,
    city: string,
    contact: string,
    refLabel: string,
    ref: string,
  ) => {
    let py = oy + 64;
    py = flow(doc, label, x, py, 260, 7.5, REG, MUTED);
    py = flow(doc, name.toUpperCase(), x, py, 260, 8.5, BOLD);
    py = flow(doc, line1, x, py, 260, 8);
    py = flow(doc, city, x, py, 260, 8);
    py = flow(doc, contact, x, py + 1, 260, 8);
    doc.font(REG).fontSize(7.5).fillColor(MUTED).text(`${refLabel}: `, x, py + 3, {
      continued: true,
      characterSpacing: 0,
    });
    doc.fillColor(INK).text(ref);
  };

  party(
    m,
    'Sender',
    o.senderName,
    o.senderLine1,
    cityLine(o.senderCity, o.senderProvince, o.senderPostcode),
    o.senderPhone ?? '',
    'Sender Reference',
    o.clientReference ?? '',
  );
  party(
    colR,
    'Receiver',
    o.receiverName,
    o.receiverLine1,
    cityLine(o.receiverCity, o.receiverProvince, o.receiverPostcode),
    [o.receiverPhone, o.receiverNotes].filter(Boolean).join('  ·  '),
    'Receiver Reference',
    '',
  );

  // Windows, plus the Dangerous Goods flag as an unticked box: there is no column
  // behind it, so it prints empty rather than silently claiming "no". Everything
  // here is kept inside the left column, clear of the Booking pair at colR.
  let y = oy + 148;
  flow(doc, `Ready: ${fmtDateTime(o.pickupAfter)}`, m, y, 120, 8);
  flow(doc, `Close: ${fmtTime(o.pickupBefore)}`, m + 122, y, 62, 8);
  doc.lineWidth(0.6).strokeColor(RULE).rect(m + 188, y - 1, 7, 7).stroke();
  flow(doc, 'Dangerous Goods', m + 198, y, 72, 6.5, REG, MUTED);
  flow(doc, `Booking: ${fmtDateTime(o.deliverAfter)}`, colR, y, 170, 8);
  flow(doc, `Close: ${fmtTime(o.deliverBefore)}`, colR + 172, y, 80, 8);

  y += 14;
  doc.font(REG).fontSize(7.5).fillColor(MUTED).text('Instructions: ', m, y, {
    continued: true,
    characterSpacing: 0,
  });
  doc.fillColor(INK).text(o.senderInstructions ?? '', { width: 260 });
  doc.fontSize(7.5).fillColor(MUTED).text('Instructions: ', colR, y, {
    continued: true,
    characterSpacing: 0,
  });
  doc.fillColor(INK).text(o.receiverNotes ?? '', { width: 260 });

  // Items.
  y = oy + 186;
  const cols = [
    { label: 'Reference', x: m, w: 68, align: 'left' as const },
    { label: 'Quantity', x: 92, w: 44, align: 'center' as const },
    { label: 'Description', x: 142, w: 180, align: 'left' as const },
    { label: 'Weight (lb)', x: 328, w: 56, align: 'center' as const },
    { label: 'Length x Width x Height (in)', x: 388, w: 112, align: 'center' as const },
    { label: 'Cubic (m3)', x: 504, w: 71, align: 'center' as const },
  ];
  rule(doc, m, y, right);
  y += 3;
  for (const c of cols) {
    doc.font(REG).fontSize(7).fillColor(MUTED);
    doc.text(c.label, c.x, y, { width: c.w, align: c.align, characterSpacing: 0 });
  }
  y += 17;
  rule(doc, m, y, right);
  y += 4;

  // shortcut: six rows per copy, the most that fits two-up on A4. An order with
  // more prints a tail line; give the docket its own page if that becomes common.
  const MAX_ROWS = 6;
  const shown = o.items.slice(0, MAX_ROWS);
  for (const it of shown) {
    const l = num(it.lengthIn);
    const w = num(it.widthIn);
    const h = num(it.heightIn);
    const cubic = cubicOf(l, w, h);
    const values = [
      it.barcode ?? '',
      String(it.qty),
      it.description,
      num(it.weightLb) ? num(it.weightLb).toFixed(1) : '',
      l && w && h ? `${l} x ${w} x ${h}` : '',
      cubic ? cubic.toFixed(4) : '',
    ];
    values.forEach((v, i) => {
      const c = cols[i]!;
      cell(doc, v, c.x, y, c.w, 8, c.align);
    });
    y += 12;
  }
  if (o.items.length > MAX_ROWS) {
    flow(doc, `+ ${o.items.length - MAX_ROWS} more line(s) on the consignment`, m, y, 300, 7, REG, MUTED);
  }

  // Totals at a fixed height so both copies line up when the sheet is cut.
  const totalsY = oy + 268;
  const t = totalsOf(o.items);
  rule(doc, m, totalsY, right);
  flow(doc, `Total Qty ${t.qty}`, m + 60, totalsY + 4, 120, 8, BOLD);
  flow(doc, `Total Weight ${t.weight.toFixed(1)}`, 280, totalsY + 4, 140, 8, BOLD);
  flow(doc, `Total Cubic ${t.cubic.toFixed(4)}`, 450, totalsY + 4, 125, 8, BOLD, INK, 'right');

  doc.lineWidth(0.6).strokeColor(RULE).rect(m, totalsY + 20, 120, 34).stroke();
  flow(doc, 'Office Use', m + 4, totalsY + 24, 110, 7, REG, MUTED);

  flow(
    doc,
    'We are not COMMON CARRIERS. Insurance is not included unless otherwise stated.\nReceived in good order and condition.',
    170,
    totalsY + 24,
    405,
    7.5,
    REG,
    INK,
    'center',
  );

  const sigY = totalsY + 76;
  const sig = [
    { x: 170, w: 125, label: '(Received Date/Time)' },
    { x: 310, w: 125, label: '(Receiver Name)' },
    { x: 450, w: 125, label: '(Receiver Signature)' },
  ];
  for (const s of sig) {
    rule(doc, s.x, sigY, s.x + s.w, 0.5, true);
    flow(doc, s.label, s.x, sigY + 3, s.w, 6.5, REG, MUTED, 'center');
  }

  const footY = totalsY + 100;
  rule(doc, m, footY, right, 0.5, true);
  flow(doc, COMPANY.site, m, footY + 4, 180, 7.5, REG, MUTED);
  flow(doc, copyLabel, 0, footY + 4, A4[0], 8, BOLD, NAVY, 'center');
  flow(doc, 'Page 1 of 1', right - 80, footY + 4, 80, 7.5, REG, MUTED, 'right');
}

/**
 * One A4 sheet, receiver's copy over sender's, with a cut line between.
 *
 * Both copies carry the order's barcode, which the reference sheet does too —
 * an earlier comment here claimed otherwise and was simply wrong about it. The
 * label on the carton is still the one built for a warehouse scanner; this is
 * for a desk that would rather not retype seventeen characters.
 */
export function drawDocket(doc: PDFKit.PDFDocument, o: PrintableConsignment, code: Buffer) {
  doc.addPage({ size: A4, margin: 0 });
  drawDocketCopy(doc, o, 0, "RECEIVER'S COPY", code);
  doc.moveTo(20, COPY_H - 6).lineTo(A4[0] - 20, COPY_H - 6).lineWidth(0.5).strokeColor(ORANGE);
  doc.dash(3, { space: 3 }).stroke().undash();
  drawDocketCopy(doc, o, COPY_H, "SENDER'S COPY", code);
}

/**
 * How many labels an order gets: one per unit of quantity, the way the reference
 * printed eight labels for a Total Qty of eight. An order with no items still
 * gets one, because something has to go on the carton.
 */
export function pieceCount(o: PrintableConsignment): number {
  const qty = o.items.reduce((n, it) => n + it.qty, 0);
  // shortcut: capped at 100 pages, a pallet's worth. Raise it when someone ships
  // more than that in one consignment and actually wants 100+ labels.
  return Math.min(Math.max(qty, 1), 100);
}

/** The scannable id for one carton: the order number plus a piece suffix. */
export function pieceCode(orderNo: string, piece: number): string {
  return `${orderNo}-${String(piece).padStart(3, '0')}`;
}

/* --------------------------------------------------------------- pod report */

/**
 * One stop's worth of proof, assembled by the service.
 *
 * The images arrive as buffers for the same reason the label's barcode does:
 * this module performs no I/O, which is what keeps the layout testable. The
 * service is also the one that decides a buffer is drawable - pdfkit embeds only
 * PNG and JPEG, while the POD sniffer also accepts WebP.
 */
export interface PodStop {
  leg: 'PICKUP' | 'DELIVERY';
  driverName: string;
  /** When the driver reported arriving, from the audit trail. Null if unrecorded. */
  arrivalAt: Date | null;
  completedAt: Date;
  signedByName: string | null;
  itemCount: number | null;
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  /** The device's fix time, which is NOT `completedAt`. See the schema comment. */
  fixAt: Date | null;
  signature: Buffer | null;
  photo: Buffer | null;
}

/** The report's grid: label column, value column, and one row's pitch. */
const POD_LX = 27;
const POD_VX = 135;
const POD_RLX = 322;
const POD_RVX = 418;
const POD_ROW = 17;
/** One stop block, measured off the reference sheet. */
const POD_BLOCK_H = 255;
/** Three picture blocks to a page, as the reference prints them. */
const POD_SHOT_H = 204;
const POD_M = 14.2;

/** A bold label and its value on one row, the only arrangement this report uses. */
function podPair(
  doc: PDFKit.PDFDocument,
  label: string,
  value: string,
  lx: number,
  vx: number,
  y: number,
  vw: number,
) {
  doc.font(BOLD).fontSize(9.6).fillColor(INK);
  doc.text(label, lx, y, { characterSpacing: 0, lineBreak: false });
  cell(doc, value, vx, y, vw, 9.6);
}

/** `DELIVERED` -> `Delivered`, the way the reference prints a status. */
function statusWord(status: string): string {
  return status
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * The coordinate as type, where the reference prints a map thumbnail.
 *
 * A static map is a per-image charge from a mapping provider for a picture of
 * these same six decimals, so the numbers go on the page and the money does not.
 * The accuracy rides along because a 400m fix and a 4m fix are different claims.
 */
function coordOf(s: PodStop): string {
  if (s.lat == null || s.lng == null) return '';
  const acc = s.accuracyM == null ? '' : `  +/-${Math.round(s.accuracyM)} m`;
  return `${s.lat.toFixed(6)}, ${s.lng.toFixed(6)}${acc}`;
}

/** Minutes between reporting arrival and capturing the proof. */
function waitOf(s: PodStop): number {
  if (!s.arrivalAt) return 0;
  const ms = s.completedAt.getTime() - s.arrivalAt.getTime();
  return ms > 0 ? ms / 60_000 : 0;
}

function legWord(leg: PodStop['leg']): string {
  return leg === 'PICKUP' ? 'Collection' : 'Delivery';
}

/**
 * pdfkit throws on anything that is not PNG or JPEG, and one corrupt object in
 * storage would otherwise take the whole report down with a 500. A labelled gap
 * beats no document at all when someone is standing at a counter holding it.
 *
 * The gap is drawn as an empty framed box, because a bare line of text next to a
 * blank area reads as a layout accident. The frame says a picture belongs here.
 *
 * "could not be displayed" rather than "missing": neither `photoPath` nor
 * `signaturePath` is nullable, so the file always exists and is always viewable
 * in the console — it simply cannot be embedded in a PDF.
 */
function picture(
  doc: PDFKit.PDFDocument,
  buf: Buffer | null,
  x: number,
  y: number,
  w: number,
  h: number,
  what: string,
) {
  const gap = () => {
    doc.lineWidth(0.5).strokeColor(RULE).rect(x, y, w, h).stroke();
    flow(doc, `${what} could not be displayed`, x, y + h / 2 - 5, w, 8, REG, MUTED, 'center');
  };

  if (!buf) {
    gap();
    return;
  }
  try {
    doc.image(buf, x, y, { fit: [w, h], align: 'center', valign: 'center' });
  } catch {
    gap();
  }
}

/** One stop: the order's identity, who signed, where, and the signature itself. */
function drawPodStop(
  doc: PDFKit.PDFDocument,
  o: PrintableConsignment,
  s: PodStop,
  oy: number,
) {
  podPair(doc, 'Consignment Number:', o.orderNo, POD_LX, POD_VX, oy, 170);
  podPair(doc, 'Status:', statusWord(o.status), POD_RLX, POD_RVX, oy, 150);

  podPair(doc, 'From:', o.senderName.toUpperCase(), POD_LX, POD_VX, oy + 17, 170);
  podPair(doc, 'Consignment Date:', fmtDate(o.createdAt), POD_RLX, POD_RVX, oy + 17, 150);

  podPair(doc, 'To:', o.receiverName.toUpperCase(), POD_LX, POD_VX, oy + 34, 170);
  podPair(doc, 'Customer:', o.client.name, POD_RLX, POD_RVX, oy + 34, 150);

  // The reference leaves a wider gap here, separating who the job is for from
  // who actually did it. Kept, because it is the one break in a dense page.
  podPair(doc, 'Driver Name:', s.driverName, POD_LX, POD_VX, oy + 61, 170);
  podPair(
    doc,
    'Arrival Time:',
    s.arrivalAt ? fmtDateTime(s.arrivalAt) : '',
    POD_RLX,
    POD_RVX,
    oy + 61,
    150,
  );

  podPair(doc, 'Completion Time:', fmtDateTime(s.completedAt), POD_LX, POD_VX, oy + 78, 170);
  podPair(doc, 'Consignment Note:', o.generalNote ?? '', POD_RLX, POD_RVX, oy + 78, 150);

  podPair(doc, 'Received By:', s.signedByName ?? '', POD_LX, POD_VX, oy + 95, 170);
  /*
   * The leg, which the reference does not print anywhere: its two blocks are
   * identical down to the word "Delivered", so a reader cannot tell the
   * collection from the handover. This fills a slot the reference leaves empty
   * rather than displacing any field it does print.
   */
  podPair(doc, 'Stop:', legWord(s.leg), POD_RLX, POD_RVX, oy + 95, 150);

  podPair(doc, 'Qty Signed For:', s.itemCount == null ? '' : String(s.itemCount), POD_LX, POD_VX, oy + 112, 170);
  podPair(doc, 'Latitude/Longitude:', coordOf(s), POD_RLX, POD_RVX, oy + 112, 150);

  flow(doc, 'Signature Image', POD_LX, oy + 136, 200, 9.6, BOLD);
  picture(doc, s.signature, 25.5, oy + 150, 107.3, 73.4, 'Signature');

  podPair(
    doc,
    'Latitude/Longitude Time:',
    s.fixAt ? fmtDateTime(s.fixAt) : '',
    POD_LX,
    152,
    oy + 227,
    150,
  );
  podPair(doc, 'Wait Time:', `${waitOf(s).toFixed(2)} minutes`, POD_RLX, POD_RVX, oy + 227, 150);
}

/**
 * The picture sheets: three blocks to a page, each one photo with the context
 * that makes it evidence - who took it, when, and where they were standing.
 */
function drawPodShots(doc: PDFKit.PDFDocument, stops: PodStop[]) {
  if (!stops.length) return;

  const right = A4[0] - POD_M;

  /*
   * One block per stop, never per drawable buffer: `photoPath` is not nullable,
   * so a proof always HAS a photo, and a leg whose picture cannot be embedded
   * must still appear saying so. Dropping the block would quietly shorten the
   * evidence and nobody reading it would know a photograph was taken.
   */
  stops.forEach((s, i) => {
    const slot = i % 3;
    if (slot === 0) doc.addPage({ size: A4, margin: 0 });
    const oy = 14 + slot * POD_SHOT_H;

    rule(doc, POD_M, oy, right, 0.7);
    flow(doc, 'Images:', POD_LX, oy + 4, 120, 9.6, BOLD);
    podPair(doc, 'Created By:', s.driverName, POD_LX, 95, oy + 21, 140);
    podPair(doc, 'Created Time:', fmtDateTime(s.completedAt), POD_LX, 95, oy + 38, 140);
    podPair(doc, 'Stop:', legWord(s.leg), POD_LX, 95, oy + 55, 140);

    flow(doc, 'Latitude/Longitude', POD_LX, oy + 79, 200, 9.6, BOLD);
    flow(doc, coordOf(s), POD_LX, oy + 93, 210, 9.6);
    podPair(doc, 'Time:', s.fixAt ? fmtDateTime(s.fixAt) : '', POD_LX, 95, oy + 112, 140);

    picture(doc, s.photo, 241, oy + 6, 328, 181, 'Photograph');
  });
}

/**
 * The POD report: one sheet carrying every stop's proof, then the photographs.
 *
 * Printable only once the order is delivered - the service enforces that, since
 * a proof report for a job still in motion would be a half-truth on letterhead.
 *
 * The page fits because a consignment has at most two proofs: the schema's
 * unique index on (consignmentId, leg) makes a third unrepresentable, and both
 * legs must be proved to reach DELIVERED at all.
 */
export function drawPodReport(doc: PDFKit.PDFDocument, o: PrintableConsignment, stops: PodStop[]) {
  doc.addPage({ size: A4, margin: 0 });

  const right = A4[0] - POD_M;

  // Header: the wordmark left, the title centred, the company block right -
  // where the reference puts a logo raster, we draw type, as both other
  // documents already do.
  wordmark(doc, 20, 20, 19);
  flow(doc, 'POD Report', 0, 36, A4[0], 23, REG, INK, 'center');

  let hy = flow(doc, COMPANY.name, 380, 15, 195, 11.5, BOLD, INK, 'right');
  hy = flow(doc, COMPANY.line1, 380, hy + 1, 195, 7.7, REG, MUTED, 'right');
  hy = flow(doc, COMPANY.city, 380, hy, 195, 7.7, REG, MUTED, 'right');
  hy = flow(doc, COMPANY.email, 380, hy, 195, 7.7, REG, MUTED, 'right');
  flow(doc, COMPANY.phone, 380, hy, 195, 7.7, REG, MUTED, 'right');

  flow(
    doc,
    'This report contains the proof of delivery recorded for the consignment below. ' +
      'It was logged by the system and by the driver during collection and delivery.',
    23,
    104,
    549,
    8.6,
    REG,
    MUTED,
    'center',
  );

  rule(doc, POD_M, 133, right, 0.7);

  let y = 141;
  for (const s of stops) {
    drawPodStop(doc, o, s, y);
    y += POD_BLOCK_H;
    rule(doc, POD_M, y - 9, right, 0.7);
  }

  // shortcut: three item lines, because this is a proof document and the docket
  // is where the full manifest lives. Raise it and the Summary needs its own page.
  const MAX_ROWS = 3;
  for (const it of o.items.slice(0, MAX_ROWS)) {
    podPair(doc, 'Item Quantity:', String(it.qty), POD_LX, 95, y, 46);
    podPair(doc, 'Item Description:', it.description ?? '', 146, 231, y, 215);
    podPair(doc, 'Item Weight:', num(it.weightLb).toFixed(1), 452, 515, y, 60);
    y += POD_ROW;
  }
  const more = o.items.length - MAX_ROWS;
  if (more > 0) {
    flow(doc, `+ ${more} more line${more === 1 ? '' : 's'} on the consignment`, POD_LX, y, 300, 7, REG, MUTED);
    y += 12;
  }

  rule(doc, POD_M, y + 4, right, 0.7);

  y += 22;
  flow(doc, 'Summary', 22, y, 200, 14.4, BOLD);
  // Its own short underline, the width of the word, as the reference draws it.
  rule(doc, 22, y + 21, 88, 1.5);

  y += 34;
  podPair(doc, 'Service:', serviceOf(o), 21, 106, y, 220);
  /*
   * Dangerous goods: a labelled blank, not the reference's "No". There is no
   * column for it, and on a safety field an invented answer is worse than an
   * obvious gap - the same rule the docket already follows.
   */
  podPair(doc, 'DGS:', '', 21, 106, y + POD_ROW, 220);
  const totalWait = stops.reduce((n, s) => n + waitOf(s), 0);
  podPair(doc, 'Total Wait Time:', totalWait.toFixed(2), 21, 106, y + 2 * POD_ROW, 220);

  drawPodShots(doc, stops);
}
