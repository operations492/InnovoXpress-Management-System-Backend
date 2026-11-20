import { AppError } from '../../utils/httpError.js';
import { mailConfigured, sendMail } from '../../utils/mailer.js';
import { BILLING, COMPANY, fmtDate } from '../documents/documents.brand.js';
import type { SendInvoiceInput } from '../../schemas/invoice.schema.js';
import * as repo from './invoices.repository.js';
import * as service from './invoices.service.js';
import { invoicePdf } from './invoices.pdf.js';

/*
 * Emailing an invoice to the customer, with the PDF attached.
 *
 * Its own file rather than a function in invoices.service: the PDF renderer
 * already imports the service, so the service importing the renderer back
 * would be a cycle. This sits above both.
 *
 * The rules, in the order they are checked:
 *  1. Approved & Locked only — a customer should only ever receive numbers
 *     that can no longer change underneath them.
 *  2. At least one consignment — an invoice for nothing is not worth sending.
 *  3. Email configured on the server — otherwise a 503 that says so, rather
 *     than a generic failure.
 * Every successful send is recorded (to, cc, by whom, when). Re-sending is
 * allowed and recorded again.
 */

const money = (n: number) =>
  `$${n.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Lower-cased and de-duplicated, so "A@x.com" and "a@x.com" are one recipient. */
function clean(list: string[] | undefined): string[] {
  return [...new Set((list ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean))];
}

/**
 * The SMTP error, said in a way an operator can act on. Gmail's "535 Username
 * and Password not accepted" almost always means a normal account password was
 * used where Google now requires an App Password.
 */
function explain(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (/535|Invalid login|Username and Password not accepted/i.test(raw)) {
    return 'The mail server rejected the login. For Gmail / Google Workspace, SMTP_PASS must be a Google App Password, not the account password.';
  }
  if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(raw)) {
    return `The mail server could not be reached (${raw.split('\n')[0]}). Check SMTP_HOST and SMTP_PORT.`;
  }
  return `The mail server refused the message: ${raw.split('\n')[0]}`;
}

export async function sendInvoice(id: string, input: SendInvoiceInput, actorId: string) {
  const inv = await service.getInvoice(id);

  if (inv.status !== 'APPROVED') {
    throw AppError.conflict(
      `Invoice ${inv.number} must be approved and locked before it is sent, so the customer only ever receives final numbers.`,
    );
  }
  if (!inv.lines || inv.lines.length === 0) {
    throw AppError.conflict(`Invoice ${inv.number} has no consignments on it, so there is nothing to send.`);
  }
  if (!mailConfigured()) {
    throw new AppError(
      503,
      'EMAIL_NOT_CONFIGURED',
      'Email is not set up on the server yet. Add SMTP_HOST, SMTP_USER and SMTP_PASS to the backend .env.',
    );
  }

  const to = clean(input.to);
  // Someone in both To and Cc gets one copy, as a To.
  const cc = clean(input.cc).filter((e) => !to.includes(e));
  if (to.length === 0) throw AppError.badRequest('Add at least one recipient');

  const pdf = await invoicePdf(id);

  const subject = `Invoice ${inv.number} from ${COMPANY.name}`;
  const text = [
    `Hello ${inv.client.name},`,
    '',
    `Please find attached invoice ${inv.number}, dated ${fmtDate(new Date(inv.invoiceDate))}, ` +
      `for ${money(inv.grandTotal)}, due on ${fmtDate(new Date(inv.dueDate))}.`,
    ...(input.message?.trim() ? ['', input.message.trim()] : []),
    '',
    'Payment methods:',
    `1. Direct deposit — ${BILLING.bank.join(', ')}`,
    `2. E-transfer to ${BILLING.etransfer}`,
    '',
    `If you have any questions about this invoice, reply to this email or write to ${BILLING.billingEmail}.`,
    '',
    'Thank you for your business,',
    COMPANY.name,
  ].join('\n');

  let messageId = '';
  try {
    ({ messageId } = await sendMail({
      to,
      cc,
      replyTo: BILLING.billingEmail,
      subject,
      text,
      attachments: [{ filename: pdf.filename, content: pdf.body, contentType: 'application/pdf' }],
    }));
  } catch (e) {
    // Nothing is recorded: a send that did not leave is not a send.
    throw new AppError(502, 'EMAIL_FAILED', explain(e));
  }

  await repo.recordSend({ invoiceId: id, toEmails: to, ccEmails: cc, sentById: actorId, messageId });
  return service.getInvoice(id);
}
