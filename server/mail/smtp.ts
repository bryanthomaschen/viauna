// Handing a built message to an SMTP server: the mailbox's own, or the provider's server of
// an address it sends as (identities.ts). Signed in as the mailbox, or as that address.
import nodemailer from "nodemailer";
import type { Endpoint } from "../config.ts";
import type { Credentials } from "../crypto.ts";
import { connectTarget } from "../netpolicy.ts";

/** It wasn't sent: the server couldn't be reached, didn't take the password (`auth`), or refused the message. */
export class SmtpError extends Error {
  auth: boolean;
  constructor(message: string, auth = false) {
    super(message);
    this.auth = auth;
  }
}

export async function smtpSend(endpoint: Endpoint, creds: Credentials, envelope: { from: string; to: string[] }, raw: Buffer): Promise<void> {
  let target: { host: string; servername?: string };
  try {
    target = await connectTarget(endpoint);
  } catch (err) {
    throw new SmtpError((err as Error).message);
  }
  const transport = nodemailer.createTransport({
    host: target.host,
    port: endpoint.port,
    secure: endpoint.security === "tls",
    requireTLS: endpoint.security === "starttls",
    ignoreTLS: endpoint.security === "none",
    auth: { user: creds.user, pass: creds.pass },
    tls: { servername: target.servername, rejectUnauthorized: endpoint.verify },
    connectionTimeout: 30_000,
    greetingTimeout: 20_000,
    socketTimeout: 120_000,
  });
  try {
    await transport.sendMail({ envelope, raw });
  } catch (err) {
    const e = err as { response?: string; message?: string; code?: string };
    if (e.code === "EAUTH") throw new SmtpError("The mail server didn't accept the password for sending.", true);
    throw new SmtpError(e.response || e.message || "unknown error");
  } finally {
    transport.close();
  }
}
