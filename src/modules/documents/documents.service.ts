/**
 * The printable documents for one consignment: a set of 4x6 labels, the two-up
 * A4 docket, and the POD report.
 *
 * Separate endpoints on purpose. A warehouse prints labels on a thermal roll and
 * the docket on office paper, usually on different machines — one combined PDF
 * would force whoever is printing to split it by hand every time. The POD report
 * is separate for a different reason: it only exists once the job is finished.
 */
import PDFDocument from 'pdfkit';
import bwipjs from 'bwip-js';
import { AppError } from '../../utils/httpError.js';
import * as repo from './documents.repository.js';
import {
  drawDocket,
  drawLabel,
  drawPodReport,
  pieceCode,
  pieceCount,
  type PodStop,
} from './documents.render.js';
/*
 * Reaching into pod's storage rather than copying it: these are POD files in the
 * POD bucket, and a second Supabase download helper pointed at the same bucket
 * would be the worse of the two evils. Listed as a tolerated leak in CLAUDE.md.
 */
import { downloadObject } from '../pod/pod.storage.js';

export interface RenderedPdf {
  filename: string;
  body: Buffer;
}

function barcode(text: string, scale: number, height: number) {
  // includetext: false — the human-readable line is drawn by the layout so its
  // font and position match the rest of the document.
  return bwipjs.toBuffer({ bcid: 'code128', text, scale, height, includetext: false });
}

/** pdfkit streams; the response needs one buffer, and these documents are small. */
function collect(doc: PDFKit.PDFDocument): Promise<Buffer> {
  const chunks: Buffer[] = [];
  return new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

async function load(id: string) {
  const o = await repo.findForPrint(id);
  if (!o) throw AppError.notFound('Consignment not found');
  return o;
}

/** One 4x6 label per piece: `1 / 8` … `8 / 8`, each with its own piece barcode. */
export async function labelPdf(id: string): Promise<RenderedPdf> {
  const o = await load(id);
  const pieces = pieceCount(o);

  const texts = Array.from({ length: pieces }, (_, i) => pieceCode(o.orderNo, i + 1));
  const codes = await Promise.all(texts.map((t) => barcode(t, 2, 10)));

  const doc = new PDFDocument({ autoFirstPage: false, info: { Title: `${o.orderNo} labels` } });
  codes.forEach((code, i) => drawLabel(doc, o, code, texts[i]!, i + 1, pieces));

  return { filename: `${o.orderNo}-labels.pdf`, body: await collect(doc) };
}

/** One A4 sheet carrying the receiver's copy and the sender's copy. */
export async function docketPdf(id: string): Promise<RenderedPdf> {
  const o = await load(id);
  const code = await barcode(o.orderNo, 2, 10);

  const doc = new PDFDocument({ autoFirstPage: false, info: { Title: `${o.orderNo} docket` } });
  drawDocket(doc, o, code);

  return { filename: `${o.orderNo}-docket.pdf`, body: await collect(doc) };
}

/*
 * pdfkit embeds PNG and JPEG and nothing else, while the POD sniffer also
 * accepts WebP — so a perfectly valid proof photo can be undrawable. Checking
 * the stored mime here means the renderer never has to guess, and the report
 * prints a labelled gap instead of throwing halfway down the page.
 */
const DRAWABLE = new Set(['image/png', 'image/jpeg']);

function drawableObject(path: string, mime: string): Promise<Buffer | null> {
  return DRAWABLE.has(mime) ? downloadObject(path) : Promise.resolve(null);
}

/**
 * When the driver reported arriving at this stop, which is the only source for
 * `Arrival Time` and therefore for the wait: the proof records the finish, the
 * audit trail records the start. Null when the step was never recorded.
 */
function arrivalOf(
  events: Array<{ toStatus: string; recordedAt: Date }>,
  leg: 'PICKUP' | 'DELIVERY',
  capturedAt: Date,
): Date | null {
  const target = leg === 'PICKUP' ? 'AT_PICKUP' : 'AT_DELIVERY';
  const hits = events.filter((e) => e.toStatus === target && e.recordedAt <= capturedAt);
  return hits.length ? hits[hits.length - 1]!.recordedAt : null;
}

/**
 * The proof report, one sheet per order plus the photographs.
 *
 * Gated on DELIVERED, and a 409 rather than a 404 because the order is real and
 * the caller is simply early: a proof report for a job still in motion would be
 * a half-truth on company letterhead, and it is the document a customer keeps.
 */
export async function podReportPdf(id: string): Promise<RenderedPdf> {
  const o = await load(id);

  if (o.status !== 'DELIVERED') {
    throw AppError.conflict('A POD report is only available once the order has been delivered');
  }

  const stops: PodStop[] = await Promise.all(
    o.proofs.map(async (p) => ({
      leg: p.leg,
      driverName: p.capturedByDriver?.name ?? o.driver?.name ?? '',
      arrivalAt: arrivalOf(o.trackingEvents, p.leg, p.capturedAt),
      completedAt: p.capturedAt,
      signedByName: p.signedByName,
      itemCount: p.itemCount,
      lat: p.podLat,
      lng: p.podLng,
      accuracyM: p.podAccuracyM,
      fixAt: p.podFixAt,
      signature: await drawableObject(p.signaturePath, p.signatureMime),
      photo: await drawableObject(p.photoPath, p.photoMime),
    })),
  );

  const doc = new PDFDocument({
    autoFirstPage: false,
    info: { Title: `${o.orderNo} POD report` },
  });
  drawPodReport(doc, o, stops);

  return { filename: `${o.orderNo}-pod-report.pdf`, body: await collect(doc) };
}
