import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

/**
 * Producing the signed copy of a document.
 *
 * The signature goes on a page APPENDED to the document, not stamped over one of
 * its existing pages. This is a customer's own PDF and we have no idea what sits
 * where: a signature placed at a guessed offset can land squarely on top of a
 * liability clause, and on a document that exists to settle cargo claims that is
 * the worst bug available. A new final page is always safe, always legible, and
 * leaves every original page byte-identical.
 *
 * `pdfkit` builds new documents and cannot open an existing one, which is why
 * this module uses `pdf-lib` instead.
 */

/** A4, matching the documents module. */
const PAGE: [number, number] = [595.28, 841.89];
const NAVY = rgb(0.102, 0.102, 0.431);
const INK = rgb(0.067, 0.067, 0.067);
const MUTED = rgb(0.333, 0.333, 0.333);

export interface StampInput {
  original: Buffer;
  originalMime: string;
  /** PNG or JPEG only — see `signableSignature` in the service. */
  signature: Buffer;
  signatureMime: string;
  heading: string;
  /** Label/value pairs printed under the signature. */
  rows: Array<[string, string]>;
}

/**
 * Wrap a non-PDF original into a one-page PDF so there is a single output format.
 *
 * WebP is deliberately unhandled: `pdf-lib` embeds PNG and JPEG only, and there
 * is no image decoder in this project to convert with. A WebP original therefore
 * gets no stamped copy — the signature is still stored and still authoritative.
 */
async function wrapImage(buf: Buffer, mime: string): Promise<PDFDocument> {
  const pdf = await PDFDocument.create();
  const img = mime === 'image/png' ? await pdf.embedPng(buf) : await pdf.embedJpg(buf);

  const page = pdf.addPage(PAGE);
  const scale = Math.min((PAGE[0] - 80) / img.width, (PAGE[1] - 80) / img.height, 1);
  page.drawImage(img, {
    x: (PAGE[0] - img.width * scale) / 2,
    y: (PAGE[1] - img.height * scale) / 2,
    width: img.width * scale,
    height: img.height * scale,
  });
  return pdf;
}

/**
 * The document with its signature page, or null if it could not be produced.
 *
 * Never throws. A malformed, encrypted or unsupported original is a reason to
 * ship the signature without a stamped copy, not a reason to fail the driver's
 * upload at the roadside.
 */
export async function stampSigned(input: StampInput): Promise<Buffer | null> {
  try {
    const pdf =
      input.originalMime === 'application/pdf'
        ? // Encrypted PDFs are common in carrier paperwork and are readable; we
          // only append, so ignoring the flag does not defeat any protection
          // the sender actually relied on.
          await PDFDocument.load(input.original, { ignoreEncryption: true })
        : await wrapImage(input.original, input.originalMime);

    const img =
      input.signatureMime === 'image/png'
        ? await pdf.embedPng(input.signature)
        : await pdf.embedJpg(input.signature);

    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const reg = await pdf.embedFont(StandardFonts.Helvetica);

    const page = pdf.addPage(PAGE);
    const m = 56;
    let y = PAGE[1] - m;

    page.drawText(input.heading, { x: m, y, size: 16, font: bold, color: NAVY });
    y -= 10;
    page.drawLine({
      start: { x: m, y },
      end: { x: PAGE[0] - m, y },
      thickness: 1,
      color: NAVY,
    });

    // The signature, scaled into a fixed box with its aspect kept. A signature
    // stretched to fill a box is not the mark the person actually made.
    y -= 30;
    const boxW = PAGE[0] - m * 2;
    const boxH = 150;
    const scale = Math.min(boxW / img.width, boxH / img.height, 1);
    const w = img.width * scale;
    const h = img.height * scale;
    page.drawImage(img, { x: m, y: y - h, width: w, height: h });
    y -= h + 8;

    page.drawLine({
      start: { x: m, y },
      end: { x: m + Math.max(w, 220), y },
      thickness: 0.75,
      color: INK,
    });
    y -= 14;
    page.drawText('Signature', { x: m, y, size: 8, font: reg, color: MUTED });

    y -= 28;
    for (const [label, value] of input.rows) {
      page.drawText(label, { x: m, y, size: 9.5, font: bold, color: INK });
      page.drawText(value, { x: m + 150, y, size: 9.5, font: reg, color: INK });
      y -= 17;
    }

    return Buffer.from(await pdf.save());
  } catch (e) {
    // Logged, not thrown: the signature is already stored and is the thing that
    // matters. The stamped copy can be regenerated later from the same two files.
    console.error('Could not produce the signed copy', e);
    return null;
  }
}
