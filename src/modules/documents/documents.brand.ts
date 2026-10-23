/**
 * Innovo's print identity, and the small formatters both documents share.
 *
 * Kept apart from the drawing code so the palette and the company block are in
 * one place: these appear on paper a customer keeps, so they are the one thing
 * here that must never drift between the label and the docket.
 */

export const COMPANY = {
  name: 'Innovo Xpress Inc',
  line1: '6660 Kennedy Road, Unit 23',
  city: 'Mississauga ON L5T 2M9',
  email: 'dispatch@innovoxpress.com',
  phone: '905-674-0666',
  site: 'www.innovoxpress.com',
};

export const NAVY = '#1A1A6E';
export const ORANGE = '#F5A623';
export const INK = '#111111';
export const MUTED = '#555555';
export const RULE = '#222222';

export const REG = 'Helvetica';
export const BOLD = 'Helvetica-Bold';

/** The two-tone wordmark, drawn as type so no image asset has to ship. */
export function wordmark(doc: PDFKit.PDFDocument, x: number, y: number, size: number) {
  doc.font(BOLD).fontSize(size).fillColor(NAVY).text('INN', x, y, { continued: true });
  doc.fillColor(ORANGE).text('O', { continued: true });
  doc.fillColor(NAVY).text('VO');
  doc
    .font(REG)
    .fontSize(size * 0.34)
    .fillColor(MUTED)
    .text('XPRESS', x + 1, y + size * 1.05, { characterSpacing: size * 0.13 });
}

/** `2026-10-19`. Dates on paperwork are read, not parsed — keep them ISO. */
export function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** `4:30 PM` — local time, because a cut-off time is read by someone standing there. */
export function fmtTime(d: Date): string {
  let h = d.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${String(d.getMinutes()).padStart(2, '0')} ${ampm}`;
}

export function fmtDateTime(d: Date): string {
  return `${fmtDate(d)} ${fmtTime(d)}`;
}

export function num(v: unknown): number {
  return v == null ? 0 : Number(v);
}

/** `Mississauga ON, L4W 2P7` — city then province, as the console shows it. */
export function cityLine(city: string, province: string | null, postcode: string | null): string {
  const tail = [province, postcode].filter(Boolean).join(', ');
  return [city, tail].filter(Boolean).join(' ');
}

/**
 * Cubic in m³, exactly as `/api/consignments/:id` derives it: L×W×H inches over
 * 61,023.744, and NOT multiplied by quantity. The API is the single definition —
 * a sheet that disagreed with the screen would be the worse bug.
 */
export function cubicOf(l: number, w: number, h: number): number {
  return l && w && h ? (l * w * h) / 61_023.744 : 0;
}

export interface Totals {
  qty: number;
  weight: number;
  cubic: number;
}

export function totalsOf(
  items: Array<{ qty: number; weightLb: unknown; lengthIn: unknown; widthIn: unknown; heightIn: unknown }>,
): Totals {
  return items.reduce<Totals>(
    (acc, it) => ({
      qty: acc.qty + it.qty,
      weight: acc.weight + num(it.weightLb),
      cubic: acc.cubic + cubicOf(num(it.lengthIn), num(it.widthIn), num(it.heightIn)),
    }),
    { qty: 0, weight: 0, cubic: 0 },
  );
}
