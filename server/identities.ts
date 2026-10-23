// The addresses a mailbox sends as: its own, and others its owner has shown are theirs
// (Settings > Accounts > Send mail as). One is sent from, answers invitations and goes in
// the vacation responder's replies only once it's confirmed: by a code emailed to it
// (SEND_AS=confirm, the default), or by the mail server taking it as the sender
// (SEND_AS=server). The mail server is asked first either way (smtp-probe.ts), so an
// address it would refuse is turned down at once. The mailbox's own address is confirmed
// by signing in with it; typed beside a separate username it proves nothing, so it's
// confirmed like any other. An address can go through its provider's own mail server
// (SEND_AS_SERVERS), signed in with a password kept only in the session that entered it
// (auth.ts, keepServerPassword).
import crypto from "node:crypto";
import type { Selectable } from "kysely";
import MailComposer from "nodemailer/lib/mail-composer";
import { type Endpoint, type Security, config, setting } from "./config.ts";
import { type Credentials, getServerSecret } from "./crypto.ts";
import type { AccountInfo } from "./imap/runtime.ts";
import { ProbeError, probeSender } from "./mail/smtp-probe.ts";
import { SmtpError, smtpSend } from "./mail/smtp.ts";
import { checkCustomHost } from "./netpolicy.ts";
import { getSettings } from "./settings.ts";
import { type IdentityTable, state } from "./state/db.ts";

export class IdentityError extends Error {
  status: 400 | 404 | 429 | 502;
  constructor(message: string, status: 400 | 404 | 429 | 502 = 400) {
    super(message);
    this.status = status;
  }
}

/** Fixed limits (docs/how-it-works/limits.md). */
export const IDENTITY_LIMITS = {
  perMailbox: 20,
  /** Codes to one address a day, and from one mailbox a day. */
  codesPerDay: 5,
  codesPerMailboxPerDay: 20,
  resendAfterMs: 60_000,
  codeHours: 24,
  tries: 5,
};

const DAY = 86_400_000;
const ADDRESS = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

export interface IdentityServer {
  host: string;
  port: number;
  security: Security;
  login: string;
}

export interface Identity {
  /** null: the mailbox's own address, with nothing recorded for it. */
  id: number | null;
  address: string;
  name: string;
  own: boolean;
  /** Confirmed in a way that counts under this server's SEND_AS. */
  confirmed: boolean;
  confirmedBy: "login" | "code" | "server" | null;
  /** Can be sent from now: confirmed, allowed here, and its own server (if any) allowed. */
  usable: boolean;
  /** When the code waiting to be entered was sent; null if none is. */
  codeSentAt: number | null;
  server: IdentityServer | null;
  /** Its own server's password is in this session. */
  password: boolean;
}

type Row = Selectable<IdentityTable>;
type Policy = "confirm" | "server" | "off";

/** Whether the mail server checked this address's password at sign-in: it's the login itself. */
const signedInAs = (account: Pick<AccountInfo, "login" | "email">) => account.login.toLowerCase() === account.email.toLowerCase();

/** A server's say-so counts only while the server is trusted for it. */
const counts = (row: Row, policy: Policy) => !!row.confirmed_at && (row.confirmed_by === "code" || (row.confirmed_by === "server" && policy === "server"));

const codeHash = (id: number, code: string) => crypto.createHmac("sha256", getServerSecret()).update(`viauna:send-as:v1:${id}:${code}`).digest("hex");

function serverOf(row: Row): IdentityServer | null {
  if (!row.smtp) return null;
  try {
    const s = JSON.parse(row.smtp) as IdentityServer;
    return typeof s.host === "string" && Number.isInteger(s.port) ? s : null;
  } catch {
    return null;
  }
}

const endpointOf = (s: IdentityServer): Endpoint => ({ host: s.host, port: s.port, security: s.security, verify: true, custom: true });

async function rows(accountId: number): Promise<Row[]> {
  return state().selectFrom("identities").selectAll().where("account_id", "=", accountId).orderBy("position").orderBy("id").execute();
}

async function rowOf(accountId: number, id: number): Promise<Row> {
  const row = await state().selectFrom("identities").selectAll().where("account_id", "=", accountId).where("id", "=", id).executeTakeFirst();
  if (!row) throw new IdentityError("That address isn't in the list.", 404);
  return row;
}

function describe(row: Row, own: boolean, policy: Policy, creds: Credentials | null): Identity {
  const server = serverOf(row);
  const confirmed = counts(row, policy);
  const waiting = !confirmed && !!row.code_hash && (row.code_expires_at ?? 0) > Date.now() && row.code_tries < IDENTITY_LIMITS.tries;
  return {
    id: row.id,
    address: row.address,
    name: row.name,
    own,
    confirmed,
    confirmedBy: confirmed ? (row.confirmed_by as "code" | "server") : null,
    usable: confirmed && (own || policy !== "off") && (!server || setting("sendAsServers")),
    codeSentAt: waiting ? row.code_sent_at : null,
    server,
    password: !!server && !!creds?.servers?.[row.id],
  };
}

/** The mailbox's addresses: its own first, then the others, as Settings shows them. */
export async function listIdentities(account: Pick<AccountInfo, "id" | "login" | "email">, creds: Credentials | null): Promise<Identity[]> {
  const policy = setting("sendAs");
  const settings = await getSettings(account.id);
  const email = account.email.toLowerCase();
  const all = await rows(account.id);
  const ownRow = all.find((r) => r.address === email);
  const own: Identity = ownRow
    ? { ...describe(ownRow, true, policy, creds), name: settings.name }
    : { id: null, address: email, name: settings.name, own: true, confirmed: false, confirmedBy: null, usable: false, codeSentAt: null, server: null, password: false };
  if (signedInAs(account)) Object.assign(own, { confirmed: true, confirmedBy: "login", usable: true, codeSentAt: null });
  return [own, ...all.filter((r) => r.address !== email).map((r) => describe(r, false, policy, creds))];
}

/** The addresses mail can go out from now, each with the name it goes with. */
export async function sendingIdentities(account: Pick<AccountInfo, "id" | "login" | "email">): Promise<Identity[]> {
  return (await listIdentities(account, null)).filter((i) => i.usable);
}

/** Who "me" is where it's someone's answer or reply: the confirmed addresses only. */
export async function sendingAddresses(account: Pick<AccountInfo, "id" | "login" | "email">): Promise<Set<string>> {
  return new Set((await sendingIdentities(account)).map((i) => i.address));
}

/** Every address shown as "me" (in lists, in "to me"): the mailbox's own, and the confirmed others. */
export async function myAddresses(accountId: number, email: string): Promise<Set<string>> {
  const policy = setting("sendAs");
  const others = (await rows(accountId)).filter((r) => counts(r, policy) && policy !== "off").map((r) => r.address);
  return new Set([email.toLowerCase(), ...others]);
}

/**
 * How mail from `address` goes out: through its provider's server, signed in with the
 * password this session holds for it, or through the mailbox's own, as the mailbox.
 */
export async function routeOf(account: AccountInfo, creds: Credentials, address: string): Promise<{ endpoint: Endpoint; creds: Credentials }> {
  const row = await state().selectFrom("identities").selectAll().where("account_id", "=", account.id).where("address", "=", address.toLowerCase()).executeTakeFirst();
  const server = row && serverOf(row);
  if (!row || !server) return { endpoint: account.smtp, creds };
  if (!setting("sendAsServers")) throw new IdentityError(`${address} goes through its own mail server, which this server no longer allows.`);
  const signIn = creds.servers?.[row.id];
  if (!signIn) throw new IdentityError(`Enter the password for ${address}'s mail server in Settings > Accounts first. It's kept in this browser only.`);
  return { endpoint: endpointOf(server), creds: signIn };
}

/** What the mail server says about sending as `address`; throws if it won't, or can't be asked. */
async function ask(endpoint: Endpoint, creds: Credentials, address: string, to: string, theirs: boolean): Promise<boolean> {
  const server = theirs ? "That mail server" : "Your mail server";
  let result: Awaited<ReturnType<typeof probeSender>>;
  try {
    result = await probeSender(endpoint, creds, address, to);
  } catch (err) {
    if (err instanceof ProbeError && err.auth) throw new IdentityError(`${server} didn't accept ${theirs ? "that username and password" : "this mailbox's password"}.`);
    throw new IdentityError(`Couldn't ask ${server.toLowerCase()} about ${address}: ${(err as Error).message}`, 502);
  }
  if (result.accepted) return true;
  if (!result.permanent) throw new IdentityError(`${server} said to try again later: ${result.reply}`, 502);
  throw new IdentityError(`${server} won't send as ${address}: ${result.reply}`);
}

function cleanServer(input: unknown, address: string): (IdentityServer & { password: string }) | null {
  if (input === undefined || input === null) return null;
  if (!setting("sendAsServers")) throw new IdentityError("This server doesn't send through other providers' mail servers.");
  const s = input as Record<string, unknown>;
  const host = String(s.host ?? "").trim().toLowerCase();
  const port = Number(s.port);
  const security = s.security === "starttls" ? "starttls" : s.security === "none" && config.allowPrivateServers ? "none" : "tls";
  const login = String(s.login ?? "").trim() || address;
  const password = String(s.password ?? "");
  if (!host) throw new IdentityError("Enter the mail server's name.");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new IdentityError("Enter the mail server's port, such as 465 or 587.");
  if (!password) throw new IdentityError("Enter the password for that mail server.");
  if (login.length > 320 || password.length > 1024) throw new IdentityError("That username or password is too long.");
  return { host, port, security, login, password };
}

/**
 * Adds an address once the mail server that would send it (the mailbox's, or its own) says
 * it would; then confirms it (SEND_AS=server) or emails it a code. Returns it, the sign-in
 * for its own server to keep in the session, and why a code couldn't be sent, if it couldn't.
 */
export async function addIdentity(
  account: AccountInfo,
  creds: Credentials,
  input: { name?: unknown; address?: unknown; server?: unknown },
): Promise<{ identity: Identity; server: Credentials | null; warning: string | null }> {
  const policy = setting("sendAs");
  if (policy === "off") throw new IdentityError("This server sends only from each mailbox's own address.");
  const address = String(input.address ?? "").trim().toLowerCase();
  const name = String(input.name ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 200);
  if (!ADDRESS.test(address) || address.length > 320) throw new IdentityError(`"${address}" isn't an email address.`);
  if (address === account.email.toLowerCase()) throw new IdentityError("That's this mailbox's own address.");
  const existing = await rows(account.id);
  if (existing.some((r) => r.address === address)) throw new IdentityError(`${address} is already in the list.`);
  if (existing.filter((r) => r.address !== account.email.toLowerCase()).length >= IDENTITY_LIMITS.perMailbox) {
    throw new IdentityError(`A mailbox can send as at most ${IDENTITY_LIMITS.perMailbox} other addresses.`);
  }
  const server = cleanServer(input.server, address);
  if (server) {
    const problem = await checkCustomHost(server.host);
    if (problem) throw new IdentityError(problem);
  }
  const signIn = server ? { user: server.login, pass: server.password } : null;
  if (server) await ask(endpointOf(server), signIn!, address, address, true);
  else await ask(account.smtp, creds, address, account.email, false);

  const now = Date.now();
  const position = Math.max(-1, ...existing.map((r) => r.position)) + 1;
  await state()
    .insertInto("identities")
    .values({
      account_id: account.id, address, name, position, created_at: now,
      smtp: server ? JSON.stringify({ host: server.host, port: server.port, security: server.security, login: server.login }) : null,
      ...(policy === "server" ? { confirmed_at: now, confirmed_by: "server" } : {}),
    })
    .execute();
  const row = (await rows(account.id)).find((r) => r.address === address)!;
  let warning: string | null = null;
  if (policy === "confirm") {
    try {
      await sendCode(account, signIn ? { ...creds, servers: { ...creds.servers, [row.id]: signIn } } : creds, row.id);
    } catch (err) {
      warning = (err as Error).message;
    }
  }
  const after = await rowOf(account.id, row.id);
  return { identity: describe(after, false, policy, signIn ? { ...creds, servers: { [row.id]: signIn } } : creds), server: signIn, warning };
}

/** The mailbox's own address when it signed in with a separate username: recorded, so it can be confirmed too. */
async function ownRow(account: AccountInfo): Promise<Row> {
  const email = account.email.toLowerCase();
  const found = (await rows(account.id)).find((r) => r.address === email);
  if (found) return found;
  await state().insertInto("identities").values({ account_id: account.id, address: email, name: "", position: -1, created_at: Date.now() }).execute();
  return (await rows(account.id)).find((r) => r.address === email)!;
}

/** The row for an id, or for the mailbox's own address (`own`), which may need recording first. */
async function target(account: AccountInfo, id: number | "own"): Promise<Row> {
  if (id !== "own") return rowOf(account.id, id);
  if (signedInAs(account)) throw new IdentityError("This mailbox's own address is confirmed already: you signed in with it.");
  return ownRow(account);
}

const spaced = (code: string) => `${code.slice(0, 4)} ${code.slice(4)}`;

/** The email with a code: what asked for it, the code, and that nothing happens without it. */
export function codeEmail(input: { from: string; fromName: string; address: string; code: string }): { subject: string; text: string; html: string } {
  const who = input.fromName ? `${input.fromName} (${input.from})` : input.from;
  const site = config.publicUrl ? ` at ${new URL(config.publicUrl).host}` : "";
  const asker = input.from === input.address ? `You asked to send mail as ${input.address}` : `${who} asked to send mail as ${input.address}`;
  const lines = [
    `${asker} from ${setting("appName")}${site}.`,
    "",
    "To allow it, enter this code in Settings > Accounts, under Send mail as:",
    "",
    `    ${spaced(input.code)}`,
    "",
    `It works for ${IDENTITY_LIMITS.codeHours} hours. If you didn't ask for this, ignore this message: nothing is sent as ${input.address} without the code.`,
    "",
  ];
  const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return {
    subject: `${spaced(input.code)} is your code to send as ${input.address}`,
    text: lines.join("\n"),
    html: [
      `<p>${escape(lines[0])}</p>`,
      `<p>${escape(lines[2])}</p>`,
      `<p style="font-size:24px;letter-spacing:2px;margin:16px 0"><b>${spaced(input.code)}</b></p>`,
      `<p style="color:#5e5e5e">${escape(lines[6])}</p>`,
    ].join("\n"),
  };
}

/**
 * Emails a new code to an address: from the mailbox through its own server, or, for an
 * address with its own server, from the address to itself through that server, which shows
 * the password works too. At most one a minute, five a day to an address and twenty a day
 * from a mailbox, each working for a day and five tries.
 */
export async function sendCode(account: AccountInfo, creds: Credentials, id: number | "own"): Promise<Identity> {
  const policy = setting("sendAs");
  const row = await target(account, id);
  const own = row.address === account.email.toLowerCase();
  if (policy === "off" && !own) throw new IdentityError("This server sends only from each mailbox's own address.");
  if (counts(row, policy)) throw new IdentityError(`${row.address} is confirmed already.`);
  const now = Date.now();
  if (row.code_sent_at && now - row.code_sent_at < IDENTITY_LIMITS.resendAfterMs) throw new IdentityError("A code went to it less than a minute ago. Wait a moment.", 429);
  const day = Math.floor(now / DAY);
  const today = row.codes_day === day ? row.codes_sent : 0;
  if (today >= IDENTITY_LIMITS.codesPerDay) throw new IdentityError(`${IDENTITY_LIMITS.codesPerDay} codes went to ${row.address} today. Try again tomorrow.`, 429);
  const mailbox = await state()
    .selectFrom("identities")
    .select((eb) => eb.fn.sum<number>("codes_sent").as("n"))
    .where("account_id", "=", account.id)
    .where("codes_day", "=", day)
    .executeTakeFirst();
  if (Number(mailbox?.n ?? 0) >= IDENTITY_LIMITS.codesPerMailboxPerDay) throw new IdentityError("This mailbox has sent as many codes as it can today. Try again tomorrow.", 429);

  const code = String(crypto.randomInt(0, 100_000_000)).padStart(8, "0");
  // Counted before it's sent, so a failing server can't be asked over and over.
  await state()
    .updateTable("identities")
    .set({ code_hash: codeHash(row.id, code), code_expires_at: now + IDENTITY_LIMITS.codeHours * 3_600_000, code_tries: 0, code_sent_at: now, codes_day: day, codes_sent: today + 1 })
    .where("id", "=", row.id)
    .execute();
  const server = serverOf(row);
  const route = server ? await routeOf(account, creds, row.address) : { endpoint: account.smtp, creds };
  const from = server ? row.address : account.email.toLowerCase();
  const settings = await getSettings(account.id);
  const mail = codeEmail({ from, fromName: server ? row.name : settings.name, address: row.address, code });
  const domain = from.split("@")[1] || "localhost";
  const raw = await new MailComposer({
    from: { name: server ? row.name : settings.name, address: from },
    to: row.address,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    messageId: `<${crypto.randomBytes(12).toString("hex")}@${domain}>`,
    date: new Date(),
    // Not a message from a person: vacation responders and the like leave it be.
    headers: { "X-Mailer": setting("appName"), "Auto-Submitted": "auto-generated" },
    disableFileAccess: true,
    disableUrlAccess: true,
  } as never)
    .compile()
    .build();
  try {
    await smtpSend(route.endpoint, route.creds, { from, to: [row.address] }, raw);
  } catch (err) {
    await state().updateTable("identities").set({ code_hash: null, code_expires_at: null }).where("id", "=", row.id).execute();
    throw new IdentityError(`The code couldn't be sent: ${(err as SmtpError).message}`, 502);
  }
  return describe(await rowOf(account.id, row.id), own, policy, creds);
}

/** Confirms an address with the code emailed to it: five tries a code, then a new one is needed. */
export async function confirmCode(account: AccountInfo, id: number | "own", input: unknown): Promise<void> {
  const row = await target(account, id);
  const code = String(input ?? "").replace(/[\s-]/g, "");
  if (!row.code_hash || (row.code_expires_at ?? 0) < Date.now()) throw new IdentityError("That code has expired, or none was sent. Send a new one.");
  // Taken before the code is checked, so tries in parallel can't get past five.
  const took = await state()
    .updateTable("identities")
    .set((eb) => ({ code_tries: eb("code_tries", "+", 1) }))
    .where("id", "=", row.id)
    .where("code_tries", "<", IDENTITY_LIMITS.tries)
    .executeTakeFirst();
  if (!Number(took.numUpdatedRows)) throw new IdentityError("Too many wrong codes. Send a new one.", 429);
  const right = /^\d{8}$/.test(code) && crypto.timingSafeEqual(Buffer.from(codeHash(row.id, code), "hex"), Buffer.from(row.code_hash, "hex"));
  if (!right) {
    const left = IDENTITY_LIMITS.tries - row.code_tries - 1;
    throw new IdentityError(left > 0 ? `That code isn't right. ${left === 1 ? "One more try" : `${left} more tries`}.` : "That code isn't right. Send a new one.");
  }
  await state()
    .updateTable("identities")
    .set({ confirmed_at: Date.now(), confirmed_by: "code", code_hash: null, code_expires_at: null, code_tries: 0 })
    .where("id", "=", row.id)
    .execute();
}

/** Asks the mail server again; with SEND_AS=server, its yes confirms the address. */
export async function checkAgain(account: AccountInfo, creds: Credentials, id: number | "own"): Promise<boolean> {
  const row = await target(account, id);
  const server = serverOf(row);
  const route = server ? await routeOf(account, creds, row.address) : { endpoint: account.smtp, creds };
  await ask(route.endpoint, route.creds, row.address, server ? row.address : account.email, !!server);
  if (setting("sendAs") !== "server") return false;
  await state().updateTable("identities").set({ confirmed_at: Date.now(), confirmed_by: "server" }).where("id", "=", row.id).execute();
  return true;
}

/** Checks a password for an address's own server, entered in another browser; returns the sign-in to keep. */
export async function checkServerPassword(account: AccountInfo, id: number, password: unknown): Promise<Credentials> {
  const row = await rowOf(account.id, id);
  const server = serverOf(row);
  if (!server) throw new IdentityError(`${row.address} goes through this mailbox's own mail server.`);
  if (!setting("sendAsServers")) throw new IdentityError("This server doesn't send through other providers' mail servers.");
  const signIn = { user: server.login, pass: String(password ?? "") };
  if (!signIn.pass) throw new IdentityError("Enter the password.");
  await ask(endpointOf(server), signIn, row.address, row.address, true);
  return signIn;
}

export async function renameIdentity(account: AccountInfo, id: number, name: unknown): Promise<void> {
  await rowOf(account.id, id);
  const clean = String(name ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 200);
  await state().updateTable("identities").set({ name: clean }).where("account_id", "=", account.id).where("id", "=", id).execute();
}

export async function removeIdentity(account: AccountInfo, id: number): Promise<void> {
  const row = await rowOf(account.id, id);
  if (row.address === account.email.toLowerCase()) throw new IdentityError("This mailbox's own address can't be removed.");
  await state().deleteFrom("identities").where("account_id", "=", account.id).where("id", "=", id).execute();
}
