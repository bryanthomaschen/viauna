// Building, sending and saving messages. The MIME is built once here, so the copy
// filed in Sent (with Bcc kept) is byte-for-byte the message that was sent.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { convert as htmlToText } from "html-to-text";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";
import { config } from "../config.ts";
import type { Credentials } from "../crypto.ts";
import { db } from "../db.ts";
import type { AccountRuntime } from "../imap/runtime.ts";
import { type Address, type MailboxRow, deleteMessages, getMailbox, insertFetched, specialMailboxes } from "../imap/store.ts";
import { connectTarget } from "../netpolicy.ts";
import { getSettings, myAddresses } from "../settings.ts";
import { getParsed } from "./fetch.ts";
import { attachmentList, escapeText, sanitizeForQuote } from "./render.ts";

export type AttachmentRef =
  | { upload: string }
  | { mailboxId: number; uid: number; index: number };

export interface ComposeInput {
  from: string;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  html: string;
  attachments: AttachmentRef[];
  /** The message this replies to (sets In-Reply-To/References, and \Answered after sending). */
  replyTo?: { mailboxId: number; uid: number } | null;
  /** The message this forwards ($Forwarded after sending). */
  forwardOf?: { mailboxId: number; uid: number } | null;
  /** The saved draft this replaces. */
  draft?: { mailboxId: number; uid: number } | null;
  /**
   * The original to quote below the new text ("On … wrote:" for a reply, the
   * "Forwarded message" block for a forward). `header` is formatted by the browser,
   * which knows the reader's language and time zone.
   */
  quote?: { mailboxId: number; uid: number; kind: "reply" | "forward"; header: string } | null;
}

export class ComposeError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const ENVELOPE_QUERY = { uid: true, flags: true, envelope: true, bodyStructure: true, internalDate: true, size: true, headers: ["references"] };

// ------------------------------------------------------------------ uploads

function uploadDir(sessionHash: string): string {
  return path.join(config.dataDir, "uploads", sessionHash.slice(0, 32));
}

export async function saveUpload(
  sessionHash: string,
  body: ReadableStream<Uint8Array> | null,
  filename: string,
  contentType: string,
): Promise<{ id: string; filename: string; size: number; contentType: string }> {
  if (!body) throw new ComposeError("Empty upload.");
  const id = crypto.randomBytes(16).toString("hex");
  const dir = uploadDir(sessionHash);
  await fs.mkdir(dir, { recursive: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > config.maxUploadBytes) {
      await reader.cancel();
      throw new ComposeError(`Attachments can be at most ${Math.round(config.maxUploadBytes / 1048576)} MB.`, 413);
    }
    chunks.push(value);
  }
  const safeName = filename.replace(/[\r\n"\\/]/g, "_").slice(0, 200) || "attachment";
  await fs.writeFile(path.join(dir, id), Buffer.concat(chunks), { mode: 0o600 });
  const meta = { filename: safeName, contentType: contentType || "application/octet-stream", size };
  await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify(meta), { mode: 0o600 });
  return { id, ...meta };
}

async function readUpload(sessionHash: string, id: string) {
  if (!/^[0-9a-f]{32}$/.test(id)) throw new ComposeError("Unknown attachment.");
  const dir = uploadDir(sessionHash);
  try {
    const meta = JSON.parse(await fs.readFile(path.join(dir, `${id}.json`), "utf8"));
    const content = await fs.readFile(path.join(dir, id));
    return { filename: meta.filename as string, contentType: meta.contentType as string, content };
  } catch {
    throw new ComposeError("An attachment has expired. Attach it again.");
  }
}

/** Removes uploads older than two days. */
export async function cleanUploads() {
  const root = path.join(config.dataDir, "uploads");
  const cutoff = Date.now() - 2 * 86_400_000;
  for (const dir of await fs.readdir(root).catch(() => [] as string[])) {
    for (const name of await fs.readdir(path.join(root, dir)).catch(() => [] as string[])) {
      const file = path.join(root, dir, name);
      const st = await fs.stat(file).catch(() => null);
      if (st && st.mtimeMs < cutoff) await fs.rm(file, { force: true });
    }
  }
}
setInterval(() => void cleanUploads(), 3600_000).unref();

// ------------------------------------------------------------------ building

/** Pasted images arrive as data: URLs; send them as inline parts instead. */
function extractDataImages(html: string) {
  const inline: { cid: string; content: Buffer; contentType: string; filename: string }[] = [];
  const out = html.replace(/(<img\b[^>]*\bsrc=)(["'])data:(image\/(?:png|jpe?g|gif|webp));base64,([A-Za-z0-9+/=\s]+)\2/gi, (_, pre, q, type, data) => {
    const cid = `${crypto.randomBytes(8).toString("hex")}@viauna`;
    inline.push({ cid, content: Buffer.from(data.replace(/\s/g, ""), "base64"), contentType: type, filename: `image-${inline.length + 1}.${type.split("/")[1]}` });
    return `${pre}${q}cid:${cid}${q}`;
  });
  return { html: out, inline };
}

function cleanAddresses(list: Address[] | undefined): Address[] {
  return (list ?? [])
    .filter((a) => a && typeof a.address === "string")
    .map((a) => ({ name: String(a.name ?? "").replace(/[\r\n]/g, " ").slice(0, 200), address: a.address.trim().toLowerCase() }))
    .filter((a) => /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(a.address))
    .slice(0, 500);
}

interface Built {
  raw: Buffer;
  rawWithBcc: Buffer;
  messageId: string;
  envelope: { from: string; to: string[] };
}

async function build(rt: AccountRuntime, sessionHash: string, input: ComposeInput, asDraft: boolean): Promise<Built> {
  const accountId = rt.account.id;
  const settings = await getSettings(accountId);
  const fromAddress = String(input.from || rt.account.email).toLowerCase();
  if (!(await myAddresses(accountId, rt.account.email)).has(fromAddress)) {
    throw new ComposeError("You can only send from your own addresses (add aliases in Settings).");
  }
  const fromName = settings.aliases.find((a) => a.address === fromAddress)?.name || settings.name;
  const to = cleanAddresses(input.to);
  const cc = cleanAddresses(input.cc);
  const bcc = cleanAddresses(input.bcc);
  if (!asDraft && !to.length && !cc.length && !bcc.length) throw new ComposeError("Add at least one recipient.");

  const subject = String(input.subject ?? "").replace(/[\r\n]+/g, " ").slice(0, 998);
  const extracted = extractDataImages(String(input.html ?? ""));
  let html = extracted.html;
  const inline: { cid: string; content: Buffer; contentType: string; filename: string }[] = extracted.inline;
  if (input.quote) {
    const mb = getMailbox(accountId, input.quote.mailboxId);
    const original = mb ? await getParsed(rt, mb, input.quote.uid) : null;
    if (original) {
      const body = typeof original.html === "string" && original.html.trim()
        ? sanitizeForQuote(original.html)
        : escapeText(original.text ?? "");
      const header = escapeText(String(input.quote.header ?? "").slice(0, 2000));
      html += input.quote.kind === "reply"
        ? `<br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">${header}<br></div><blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">${body}</blockquote></div>`
        : `<br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">${header}<br></div><br>${body}</div>`;
      // The original's inline images, so the quote still shows them.
      for (const att of original.attachments) {
        const cid = att.cid?.replace(/^<|>$/g, "");
        if (cid && att.contentType.startsWith("image/") && body.includes(`cid:${cid}`)) {
          inline.push({ cid, content: att.content, contentType: att.contentType, filename: att.filename || "image" });
        }
      }
    }
  }
  if (html.length > 5_000_000) throw new ComposeError("The message is too long.");

  let inReplyTo: string | undefined;
  let references: string[] | undefined;
  if (input.replyTo) {
    const mb = getMailbox(accountId, input.replyTo.mailboxId);
    const parsed = mb ? await getParsed(rt, mb, input.replyTo.uid) : null;
    if (parsed?.messageId) {
      inReplyTo = parsed.messageId;
      const prior = parsed.references ? (Array.isArray(parsed.references) ? parsed.references : [parsed.references]) : [];
      references = [...prior, parsed.messageId].slice(-30);
    }
  }

  const attachments: { filename: string; content: Buffer; contentType: string; cid?: string }[] = [];
  let total = 0;
  for (const ref of input.attachments ?? []) {
    let item: { filename: string; content: Buffer; contentType: string };
    if ("upload" in ref) {
      item = await readUpload(sessionHash, ref.upload);
    } else {
      const mb = getMailbox(accountId, ref.mailboxId);
      const parsed = mb ? await getParsed(rt, mb, ref.uid) : null;
      const att = parsed?.attachments[ref.index];
      if (!att) throw new ComposeError("An attachment from the original message is no longer available.");
      item = { filename: att.filename || "attachment", content: att.content, contentType: att.contentType };
    }
    total += item.content.length;
    attachments.push(item);
  }
  if (total > config.maxUploadBytes * 2) throw new ComposeError("The attachments are too large to send together.", 413);

  const domain = fromAddress.split("@")[1] || "localhost";
  const messageId = `<${crypto.randomBytes(12).toString("hex")}@${domain}>`;
  const options = {
    from: { name: fromName, address: fromAddress },
    to,
    cc,
    bcc,
    subject,
    html,
    text: htmlToText(html, { wordwrap: 76, selectors: [{ selector: "img", format: "skip" }] }),
    inReplyTo,
    references,
    messageId,
    date: new Date(),
    attachments: [...attachments, ...inline],
    headers: { "X-Mailer": config.appName },
    disableFileAccess: true,
    disableUrlAccess: true,
  };
  const node = new MailComposer(options as never).compile();
  const raw = await node.build();
  const withBcc = new MailComposer(options as never).compile();
  withBcc.keepBcc = true;
  const rawWithBcc = await withBcc.build();
  return {
    raw,
    rawWithBcc,
    messageId,
    envelope: { from: fromAddress, to: [...to, ...cc, ...bcc].map((a) => a.address) },
  };
}

// ------------------------------------------------------------------ IMAP helpers

/** Appends to a folder and indexes the new message immediately. */
async function appendAndIndex(rt: AccountRuntime, mb: MailboxRow, raw: Buffer, flags: string[]): Promise<number | null> {
  const client = await rt.fg.get();
  const res = await client.append(mb.path, raw, flags, new Date());
  if (res && res.uid) {
    await rt.withMailbox(mb.path, async (c) => {
      for await (const msg of c.fetch(String(res.uid), ENVELOPE_QUERY, { uid: true })) insertFetched(rt.account.id, mb, msg);
    });
    rt.notify([mb.id]);
    return res.uid;
  }
  rt.syncMailboxSoon(mb.id);
  return null;
}

/** Expunges a replaced draft — only ever from the Drafts folder, whatever the client says. */
async function removeDraft(rt: AccountRuntime, ref: ComposeInput["draft"]) {
  if (!ref) return;
  const mb = getMailbox(rt.account.id, ref.mailboxId);
  if (!mb || mb.id !== specialMailboxes(rt.account.id).drafts?.id) return;
  await rt.withMailbox(mb.path, (client) => client.messageDelete(String(ref.uid), { uid: true }));
  deleteMessages(mb.id, [ref.uid]);
  rt.notify([mb.id]);
}

async function addFlag(rt: AccountRuntime, ref: { mailboxId: number; uid: number } | null | undefined, flag: string) {
  if (!ref) return;
  const mb = getMailbox(rt.account.id, ref.mailboxId);
  if (!mb) return;
  await rt.withMailbox(mb.path, (client) => client.messageFlagsAdd(String(ref.uid), [flag], { uid: true }));
  db().run(
    `UPDATE messages SET ${flag === "\\Answered" ? "answered" : "forwarded"} = 1 WHERE mailbox_id = ? AND uid = ?`,
    mb.id,
    ref.uid,
  );
  rt.notify([mb.id]);
}

// ------------------------------------------------------------------ public

/** Sends a built message through the mailbox's SMTP server, as the mailbox, with its own password. */
export async function sendRaw(rt: AccountRuntime, creds: Credentials, envelope: Built["envelope"], raw: Buffer) {
  const smtp = rt.account.smtp;
  let target: { host: string; servername?: string };
  try {
    target = await connectTarget(smtp);
  } catch (err) {
    throw new ComposeError((err as Error).message, 502);
  }
  const transport = nodemailer.createTransport({
    host: target.host,
    port: smtp.port,
    secure: smtp.security === "tls",
    requireTLS: smtp.security === "starttls",
    ignoreTLS: smtp.security === "none",
    auth: { user: creds.user, pass: creds.pass },
    tls: { servername: target.servername, rejectUnauthorized: smtp.verify },
    connectionTimeout: 30_000,
    greetingTimeout: 20_000,
    socketTimeout: 120_000,
  });
  try {
    await transport.sendMail({ envelope, raw });
  } catch (err) {
    const e = err as { responseCode?: number; response?: string; message?: string; code?: string };
    if (e.code === "EAUTH") throw new ComposeError("The mail server rejected your password for sending.", 502);
    throw new ComposeError(`The message wasn't sent: ${e.response || e.message || "unknown error"}`, 502);
  } finally {
    transport.close();
  }
}

/**
 * A calendar email (iMIP, RFC 6047): an invitation, an update, a cancellation or an
 * answer, as the mailbox. Its text and HTML for people, and the iCalendar object as a
 * text/calendar part with its method, which calendar apps read, and as invite.ics.
 * Not filed in Sent: the calendar is its record.
 */
export async function sendCalendarMail(
  rt: AccountRuntime,
  creds: Credentials,
  mail: { to: Address[]; subject: string; text: string; html: string; method: "REQUEST" | "REPLY" | "CANCEL"; ics: string },
): Promise<void> {
  const settings = await getSettings(rt.account.id);
  const from = rt.account.email.toLowerCase();
  const to = cleanAddresses(mail.to);
  if (!to.length) return;
  const domain = from.split("@")[1] || "localhost";
  const node = new MailComposer({
    from: { name: settings.name, address: from },
    to,
    subject: mail.subject.replace(/[\r\n]+/g, " ").slice(0, 998),
    text: mail.text,
    html: mail.html,
    icalEvent: { method: mail.method, filename: "invite.ics", content: mail.ics },
    messageId: `<${crypto.randomBytes(12).toString("hex")}@${domain}>`,
    date: new Date(),
    headers: { "X-Mailer": config.appName },
    disableFileAccess: true,
    disableUrlAccess: true,
  } as never).compile();
  await sendRaw(rt, creds, { from, to: to.map((a) => a.address) }, await node.build());
}

/** Sends with the requesting session's own password, which it has just proven. */
export async function sendMessage(rt: AccountRuntime, sessionHash: string, input: ComposeInput, creds: Credentials) {
  const built = await build(rt, sessionHash, input, false);
  await sendRaw(rt, creds, built.envelope, built.raw);

  // The message is out; filing and flagging are best-effort from here on.
  const errors: string[] = [];
  const sent = specialMailboxes(rt.account.id).sent;
  let sentRef: { mailboxId: number; uid: number } | null = null;
  if (sent) {
    try {
      const uid = await appendAndIndex(rt, sent, built.rawWithBcc, ["\\Seen"]);
      if (uid) sentRef = { mailboxId: sent.id, uid };
    } catch (err) {
      errors.push(`Couldn't save a copy in Sent (${(err as Error).message}).`);
    }
  }
  await removeDraft(rt, input.draft).catch(() => {});
  await addFlag(rt, input.replyTo, "\\Answered").catch(() => {});
  await addFlag(rt, input.forwardOf, "$Forwarded").catch(() => {});
  const threadId = sentRef
    ? db().get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE mailbox_id = ? AND uid = ?", sentRef.mailboxId, sentRef.uid)?.thread_id
    : undefined;
  return { messageId: built.messageId, sent: sentRef, threadId, warnings: errors };
}

export async function saveDraft(rt: AccountRuntime, sessionHash: string, input: ComposeInput) {
  const drafts = specialMailboxes(rt.account.id).drafts;
  if (!drafts) throw new ComposeError("This mailbox has no Drafts folder.");
  const built = await build(rt, sessionHash, input, true);
  const uid = await appendAndIndex(rt, drafts, built.rawWithBcc, ["\\Draft", "\\Seen"]);
  await removeDraft(rt, input.draft).catch(() => {});
  if (!uid) return { draft: null, attachments: null };
  // The new draft now holds the attachments; later saves must read them from it,
  // since the draft they came from has just been deleted.
  const parsed = await getParsed(rt, drafts, uid);
  const html = parsed && typeof parsed.html === "string" ? parsed.html : null;
  const attachments = parsed
    ? attachmentList(parsed, html)
        .filter((a) => !a.inline)
        .map((a) => ({ mailboxId: drafts.id, uid, index: a.index, filename: a.filename, size: a.size, contentType: a.contentType }))
    : null;
  return { draft: { mailboxId: drafts.id, uid }, attachments };
}

export async function discardDraft(rt: AccountRuntime, ref: { mailboxId: number; uid: number }) {
  const drafts = specialMailboxes(rt.account.id).drafts;
  if (!drafts || drafts.id !== ref.mailboxId) throw new ComposeError("That isn't a draft.");
  await removeDraft(rt, ref);
}
