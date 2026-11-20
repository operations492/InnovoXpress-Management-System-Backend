import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../config/env.js';

/**
 * Outgoing mail — currently only for sending invoices.
 *
 * One transport for the whole process, created on first use rather than at
 * import, so a server started without SMTP settings boots normally and only
 * the send itself reports that email is not set up.
 *
 * Port 465 is TLS from the first byte; anything else (587, the usual) starts
 * plain and upgrades with STARTTLS, which nodemailer does when `secure` is
 * false.
 */

let transporter: Transporter | null = null;

/** True when there is enough configured to attempt a send at all. */
export function mailConfigured(): boolean {
  return Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS);
}

function transport(): Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    });
  }
  return transporter;
}

export interface OutgoingMail {
  to: string[];
  cc?: string[];
  /** Where a customer's reply goes, when it should not be the sending mailbox. */
  replyTo?: string;
  subject: string;
  text: string;
  attachments?: Array<{ filename: string; content: Buffer; contentType?: string }>;
}

/** Send one message. Throws on any SMTP failure; the caller decides what to say. */
export async function sendMail(m: OutgoingMail): Promise<{ messageId: string }> {
  const info = await transport().sendMail({
    from: env.SMTP_FROM || env.SMTP_USER,
    to: m.to,
    ...(m.cc && m.cc.length ? { cc: m.cc } : {}),
    ...(m.replyTo ? { replyTo: m.replyTo } : {}),
    subject: m.subject,
    text: m.text,
    attachments: m.attachments,
  });
  return { messageId: String(info.messageId ?? '') };
}
