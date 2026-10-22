// Viauna's own sender: mail the server sends itself rather than as someone, from the
// mailbox SENDER_ADDRESS names. For now, reminders by email: they fall due when nobody may
// be signed in, and a mailbox's own password can be used only while its owner is (it's
// encrypted with a key their session holds). An email reminder goes only to the mailbox's
// own address, and only for mailboxes on this server's own mail server (IMAP_HOST), so the
// sender can't be made to mail anyone else.
import nodemailer from "nodemailer";
import { VERSION, config, onOwnServer, type Endpoint } from "./config.ts";
import { addReminderChannel, type Notice } from "./reminders.ts";
import { state } from "./state/db.ts";

/** Whether this server sends email reminders for a mailbox. */
export function emailReminders(account: { imap: Endpoint }): boolean {
  return !!config.sender && onOwnServer(account);
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** "Friday 23 October, 09:00 – 09:15", "Friday 23 October": when, in the zone it was worked out in. */
function when(n: Pick<Notice, "allDay" | "start" | "end" | "zone">): string {
  if (n.allDay) {
    const last = new Date(Date.parse(`${n.end}T00:00:00Z`) - 86_400_000);
    const day = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
    return n.end && last.toISOString().slice(0, 10) > n.start ? day.formatRange(new Date(`${n.start}T00:00:00Z`), last) : day.format(new Date(`${n.start}T00:00:00Z`));
  }
  const f = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone: n.zone });
  return f.formatRange(new Date(n.start), new Date(n.end));
}

/** The email for a reminder: its subject, and its text as plain text and as HTML. */
export function reminderEmail(n: Notice, link: string | null): { subject: string; text: string; html: string } {
  const title = n.title || "(No title)";
  const time = when(n);
  const zone = n.allDay ? "" : ` (${n.zone.replace(/_/g, " ")})`;
  const short = n.allDay
    ? new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${n.start}T00:00:00Z`))
    : new Intl.DateTimeFormat("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit", timeZone: n.zone }).format(new Date(n.start));
  const lines = [title, `${time}${zone}`, n.location, n.video ? `Video call: ${n.video}` : ""].filter(Boolean);
  const footer = "You set this reminder in your calendar. Change or remove it in the event.";
  return {
    subject: `Reminder: ${title}, ${short}`,
    text: [...lines, "", ...(link ? [`Open it: ${link}`, ""] : []), footer, ""].join("\n"),
    html: [
      `<p style="font-size:18px;margin:0 0 8px">${escape(title)}</p>`,
      `<p style="margin:0 0 4px">${escape(`${time}${zone}`)}</p>`,
      n.location ? `<p style="margin:0 0 4px">${escape(n.location)}</p>` : "",
      n.video ? `<p style="margin:0 0 4px"><a href="${escape(n.video)}">Join the video call</a></p>` : "",
      link ? `<p style="margin:16px 0"><a href="${escape(link)}">Open it in the calendar</a></p>` : "",
      `<p style="color:#5e5e5e;font-size:12px;margin-top:24px">${escape(footer)}</p>`,
    ].join("\n"),
  };
}

/** Sends one email from the sender; throws if its SMTP server won't take it. */
export async function sendAsSender(to: string, mail: { subject: string; text: string; html: string }): Promise<void> {
  const s = config.sender;
  if (!s) throw new Error("No sender is set up (SENDER_ADDRESS).");
  const transport = nodemailer.createTransport({
    host: s.smtp.host,
    port: s.smtp.port,
    secure: s.smtp.security === "tls",
    requireTLS: s.smtp.security === "starttls",
    ignoreTLS: s.smtp.security === "none",
    ...(s.password ? { auth: { user: s.login, pass: s.password } } : {}),
    tls: { servername: s.smtp.servername, rejectUnauthorized: s.smtp.verify },
    connectionTimeout: 30_000,
    greetingTimeout: 20_000,
    socketTimeout: 60_000,
  });
  try {
    await transport.sendMail({
      from: { name: s.name ?? config.appName, address: s.address },
      to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      // Sent by a machine: no out-of-office replies to it (RFC 3834).
      headers: { "Auto-Submitted": "auto-generated", "X-Auto-Response-Suppress": "All", "X-Mailer": `Viauna ${VERSION}` },
    });
  } finally {
    transport.close();
  }
}

// A due reminder by email, to the mailbox's own address.
addReminderChannel(async (notice) => {
  if (notice.method !== "email" || !config.sender) return;
  const account = await state().selectFrom("accounts").select(["email", "imap"]).where("id", "=", notice.accountId).executeTakeFirst();
  if (!account || !emailReminders({ imap: JSON.parse(account.imap) as Endpoint })) return;
  const link = config.publicUrl ? `${config.publicUrl.replace(/\/$/, "")}/mailbox/${encodeURIComponent(account.email)}/calendar/day/${notice.start.slice(0, 10)}` : null;
  await sendAsSender(account.email, reminderEmail(notice, link));
});
