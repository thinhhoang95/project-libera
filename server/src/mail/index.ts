// Outgoing email. With SMTP_URL set, mail goes through nodemailer; without
// it, the message is written to the log so invitations work in development
// without a mail server (the link is in the logged text).

import nodemailer from "nodemailer";

import type { ServerContext } from "../context.js";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export function createMailer(context: Pick<ServerContext, "config" | "log">): Mailer {
  const { SMTP_URL, MAIL_FROM } = context.config;
  if (!SMTP_URL) {
    return {
      async send(message) {
        context.log.info({ mail: message }, `Email to ${message.to} (SMTP_URL unset, not sent): ${message.subject}`);
      },
    };
  }
  const transport = nodemailer.createTransport(SMTP_URL);
  return {
    async send(message) {
      await transport.sendMail({ from: MAIL_FROM, to: message.to, subject: message.subject, text: message.text });
    },
  };
}

// The context type belongs to app.ts, so the mailer hangs off it here rather
// than as a field. Tests swap in a recording mailer with setMailer.
const mailers = new WeakMap<object, Mailer>();

export function getMailer(context: ServerContext): Mailer {
  let mailer = mailers.get(context);
  if (!mailer) {
    mailer = createMailer(context);
    mailers.set(context, mailer);
  }
  return mailer;
}

export function setMailer(context: ServerContext, mailer: Mailer): void {
  mailers.set(context, mailer);
}

/** Sends without failing the caller: email is a courtesy, the data is already saved. */
export async function sendMailSafely(context: ServerContext, message: MailMessage): Promise<boolean> {
  try {
    await getMailer(context).send(message);
    return true;
  } catch (error) {
    context.log.error({ err: error, to: message.to, subject: message.subject }, "Sending email failed");
    return false;
  }
}
