// Reminders by email (server/sender.ts): what the email says, that it goes from the server's
// own sender to the mailbox's own address, and only for mailboxes on this server's own mail
// server. A local SMTP server stands in for the real one.
import fs from "node:fs";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import { simpleParser } from "mailparser";
import { SMTPServer } from "smtp-server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createEvent, listCalendars } from "../server/calendar.ts";
import { type Endpoint, config, endpointKey } from "../server/config.ts";
import { sha256 } from "../server/crypto.ts";
import { type Notice, sendDueReminders } from "../server/reminders.ts";
import { reminderEmail } from "../server/sender.ts";
import { type StateStore, openState, setState, state } from "../server/state/db.ts";
import { ENGINES, emptyDatabase } from "./databases.ts";

const notice = (over: Partial<Notice> = {}): Notice => ({
  accountId: 7, eventId: 1, occurrence: null, method: "email", minutes: 10, at: 0, title: "Standup", allDay: false,
  start: "2026-10-23T01:00:00.000Z", end: "2026-10-23T01:15:00.000Z", location: "Room 3", video: "https://meet.example.com/x", zone: "Asia/Singapore", ...over,
});

describe("a reminder's email", () => {
  it("says what, when in the calendar's zone, where, and links to it", () => {
    const mail = reminderEmail(notice(), "https://mail.example.com/mailbox/me%40example.test/calendar/day/2026-10-23");
    expect(mail.subject).toBe("Reminder: Standup, Fri 09:00");
    expect(mail.text).toBe([
      "Standup", "Friday 23 October, 09:00–09:15 (Asia/Singapore)", "Room 3", "Video call: https://meet.example.com/x", "",
      "Open it: https://mail.example.com/mailbox/me%40example.test/calendar/day/2026-10-23", "",
      "You set this reminder in your calendar. Change or remove it in the event.", "",
    ].join("\n"));
    expect(mail.html).toContain('<a href="https://meet.example.com/x">Join the video call</a>');
  });

  it("gives an all-day event's days, and escapes what it puts in HTML", () => {
    const mail = reminderEmail(notice({ allDay: true, title: "<Trip>", start: "2026-10-23", end: "2026-10-26", location: "", video: null }), null);
    expect(mail.subject).toBe("Reminder: <Trip>, Fri 23 Oct");
    // Intl puts thin spaces round the dash.
    expect(mail.text.split("\n")[1].replace(/\s/g, " ")).toBe("Friday 23 October – Sunday 25 October");
    expect(mail.html).toContain("&#60;Trip&#62;");
    expect(mail.text).not.toContain("Open it");
  });
});

describe.each(ENGINES)("sending email reminders on $name", ({ url }) => {
  let store: StateStore;
  let dir: string;
  let port = 0;
  const received: { from: string; to: string[]; raw: string; user?: string }[] = [];
  const smtp = new SMTPServer({
    secure: false, authOptional: true, disabledCommands: ["STARTTLS"],
    onAuth: (auth, _session, cb) => (auth.password === "s3cret" ? cb(null, { user: auth.username }) : cb(new Error("bad password"))),
    onData: (stream, session, cb) => {
      let raw = "";
      stream.on("data", (c: Buffer) => (raw += c.toString()));
      stream.on("end", () => {
        received.push({ from: session.envelope.mailFrom ? session.envelope.mailFrom.address : "", to: session.envelope.rcptTo.map((r) => r.address), raw, user: session.user as string | undefined });
        cb();
      });
    },
  });
  const own: Endpoint = { host: "imap.example.test", port: 993, security: "tls", verify: true };
  const saved = { imap: config.imap, sender: config.sender, publicUrl: config.publicUrl };

  beforeAll(async () => {
    port = await new Promise((r) => smtp.listen(0, "127.0.0.1", () => r((smtp.server.address() as net.AddressInfo).port)));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "viauna-sender-"));
    if (url) await emptyDatabase(url);
    store = await openState(url, path.join(dir, "state.db"));
  });

  afterAll(async () => {
    smtp.close();
    await store.db.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    setState(store);
    received.length = 0;
    config.imap = own;
    config.sender = { address: "noreply@example.test", name: undefined, login: "noreply@example.test", password: "s3cret", smtp: { host: "127.0.0.1", port, security: "none", verify: false } };
    config.publicUrl = "https://mail.example.test";
    await state().deleteFrom("events").execute();
    await state().deleteFrom("calendars").execute();
    await state().deleteFrom("accounts").execute();
    const custom = { ...own, host: "imap.elsewhere.test", custom: true };
    for (const [id, email, imap] of [[7, "me@example.test", own], [8, "them@elsewhere.test", custom]] as const) {
      const json = endpointKey(imap);
      await state().insertInto("accounts").values({ id, login: email, email, imap: json, imap_hash: sha256(json), smtp: "{}", settings: JSON.stringify({ timeZone: "Asia/Singapore" }), created_at: 1 }).execute();
    }
  });

  afterEach(() => {
    Object.assign(config, saved);
    setState(null);
  });

  const due = async (accountId: number) => {
    const start = Math.ceil((Date.now() + 30 * 60_000) / 60_000) * 60_000;
    const wall = (ms: number) => new Date(ms + 8 * 3_600_000).toISOString().slice(0, 16);
    const calendar = (await listCalendars(accountId, "Me"))[0].id;
    await createEvent(accountId, calendar, { title: "Standup", allDay: false, start: wall(start), end: wall(start + 900_000), zone: "Asia/Singapore", reminders: [{ method: "email", minutes: 10 }] }, "Asia/Singapore");
    await sendDueReminders(Date.now());
    return sendDueReminders(start - 10 * 60_000 + 1000);
  };

  it("emails the mailbox's own address from the sender, signed in as it", async () => {
    expect(await due(7)).toBe(1);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ from: "noreply@example.test", to: ["me@example.test"], user: "noreply@example.test" });
    const mail = await simpleParser(received[0].raw);
    expect(mail.subject).toMatch(/^Reminder: Standup, /);
    expect(mail.headers.get("auto-submitted")).toBe("auto-generated");
    expect(mail.text).toContain("https://mail.example.test/mailbox/me%40example.test/calendar/day/");
  });

  it("emails nobody for a mailbox on another mail server, nor without a sender", async () => {
    await due(8);
    expect(received).toEqual([]);
    config.sender = null;
    await state().deleteFrom("events").execute();
    await due(7);
    expect(received).toEqual([]);
  });

  it("emails nobody when the address shown isn't the login the mail server checked", async () => {
    // Signed in to their own mailbox as "me" while typing someone else's address.
    await state().updateTable("accounts").set({ email: "someone@else.test" }).where("id", "=", 7).execute();
    await due(7);
    expect(received).toEqual([]);
  });
});
