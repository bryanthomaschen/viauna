// Invitations by email (server/invitations.ts) on each state-store engine: reading one from
// a message as calendar apps send it, answering it (kept with the answer, and a REPLY to
// the organiser, caught by a local SMTP server), newer versions, cancellations, files to
// add, and a guest's answer counted by the organiser.
import fs from "node:fs";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import { simpleParser } from "mailparser";
import { SMTPServer } from "smtp-server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createEvent, eventsBetween, getEvent, listCalendars } from "../server/calendar.ts";
import { config } from "../server/config.ts";
import { sha256 } from "../server/crypto.ts";
import type { AccountRuntime } from "../server/imap/runtime.ts";
import { actOnInvitation, answerEvent, calendarPart, viewInvitation } from "../server/invitations.ts";
import { parseMessage } from "../server/mail/render.ts";
import { type StateStore, openState, setState, state } from "../server/state/db.ts";
import { ENGINES, emptyDatabase } from "./databases.ts";

const SG = "Asia/Singapore";

/** An iCalendar object as Google sends an invitation. */
const ics = (method: string, over: { seq?: number; start?: string; partstat?: string; attendees?: string[]; rid?: string; status?: string } = {}) =>
  [
    "BEGIN:VCALENDAR", "PRODID:-//Google Inc//Google Calendar 70.9054//EN", "VERSION:2.0", "CALSCALE:GREGORIAN", `METHOD:${method}`,
    "BEGIN:VEVENT",
    `DTSTART:${over.start ?? "20270301T010000Z"}`, `DTEND:${(over.start ?? "20270301T010000Z").replace(/T01/, "T02")}`, "DTSTAMP:20261022T000000Z",
    "ORGANIZER;CN=Ann Lee:mailto:ann@elsewhere.test", "UID:abc123@google.com",
    ...(over.attendees ?? [
      `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=${over.partstat ?? "NEEDS-ACTION"};RSVP=TRUE;CN=me@example.test;X-NUM-GUESTS=0:mailto:me@example.test`,
      "ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=TRUE;CN=Ann Lee:mailto:ann@elsewhere.test",
    ]),
    ...(over.rid ? [`RECURRENCE-ID:${over.rid}`] : []),
    `SEQUENCE:${over.seq ?? 0}`, `STATUS:${over.status ?? "CONFIRMED"}`, "SUMMARY:Planning", "LOCATION:Room 3", "TRANSP:OPAQUE",
    "END:VEVENT", "END:VCALENDAR", "",
  ].join("\r\n");

/** A message as calendar apps send one (RFC 6047): text, HTML, and the object with its method, and as invite.ics. */
const message = (calendar: string, method: string) =>
  [
    "From: Ann Lee <ann@elsewhere.test>", "To: me@example.test", "Subject: Invitation: Planning", "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="m"', "", "--m", 'Content-Type: multipart/alternative; boundary="a"', "",
    "--a", "Content-Type: text/plain; charset=UTF-8", "", "You have been invited to Planning.", "",
    "--a", `Content-Type: text/calendar; charset=UTF-8; method=${method}`, "Content-Transfer-Encoding: 7bit", "", calendar,
    "--a--", "", "--m", 'Content-Type: application/ics; name="invite.ics"', 'Content-Disposition: attachment; filename="invite.ics"',
    "Content-Transfer-Encoding: base64", "", Buffer.from(calendar).toString("base64"), "--m--", "",
  ].join("\r\n");

const partOf = async (calendar: string, method: string) => calendarPart(await parseMessage(Buffer.from(message(calendar, method))))!;

describe.each(ENGINES)("invitations on $name", ({ url }) => {
  let store: StateStore;
  let dir: string;
  let primary: number;
  let port = 0;
  const sent: { to: string[]; raw: string }[] = [];
  const smtp = new SMTPServer({
    secure: false, authOptional: true, disabledCommands: ["STARTTLS"],
    onAuth: (_a, _s, cb) => cb(null, { user: "me" }),
    onData: (stream, session, cb) => {
      let raw = "";
      stream.on("data", (c: Buffer) => (raw += c.toString()));
      stream.on("end", () => {
        sent.push({ to: session.envelope.rcptTo.map((r) => r.address), raw });
        cb();
      });
    },
  });
  const allowed = config.allowPrivateServers;
  let rt: AccountRuntime;
  const creds = { user: "me@example.test", pass: "pass" };
  const imap = JSON.stringify({ host: "imap.example.test", port: 993, security: "tls", servername: null, verify: true });

  beforeAll(async () => {
    port = await new Promise((r) => smtp.listen(0, "127.0.0.1", () => r((smtp.server.address() as net.AddressInfo).port)));
    rt = { account: { id: 7, email: "me@example.test", login: "me@example.test", smtp: { host: "127.0.0.1", port, security: "none", verify: false, custom: true } } } as unknown as AccountRuntime;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "viauna-invitations-"));
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
    config.allowPrivateServers = true;
    sent.length = 0;
    await state().deleteFrom("events").execute();
    await state().deleteFrom("calendars").execute();
    await state().deleteFrom("accounts").execute();
    await state().insertInto("accounts").values({ id: 7, login: "me@example.test", email: "me@example.test", imap, imap_hash: sha256(imap), smtp: "{}", settings: JSON.stringify({ timeZone: SG }), created_at: 1 }).execute();
    primary = (await listCalendars(7, "Me"))[0].id;
  });

  afterEach(() => {
    config.allowPrivateServers = allowed;
    setState(null);
  });

  it("reads an invitation as Google sends one, with what it clashes with", async () => {
    await createEvent(7, primary, { title: "Dentist", allDay: false, start: "2027-03-01T09:30", end: "2027-03-01T10:30", zone: SG }, SG);
    const part = await partOf(ics("REQUEST"), "REQUEST");
    expect(part.method).toBe("REQUEST");
    const view = (await viewInvitation(7, part, SG))!;
    expect(view).toMatchObject({
      method: "REQUEST", title: "Planning", allDay: false, start: "2027-03-01T01:00:00.000Z", location: "Room 3",
      organizer: { address: "ann@elsewhere.test", name: "Ann Lee" },
      you: { address: "me@example.test", response: "needs-action" }, youOrganize: false, stored: null, outdated: false,
    });
    expect(view.attendees).toHaveLength(2);
    expect(view.clashes.map((e) => e.title)).toEqual(["Dentist"]);
  });

  it("answers yes: keeps it with the answer and the usual reminders, and tells the organiser", async () => {
    const part = await partOf(ics("REQUEST"), "REQUEST");
    expect(await actOnInvitation(rt, creds, part, "accepted", null)).toEqual({ sent: true });
    const view = (await viewInvitation(7, part, SG))!;
    expect(view.stored).toMatchObject({ calendarId: primary, response: "accepted", sequence: 0 });
    const event = await getEvent(7, view.stored!.id, SG);
    expect(event).toMatchObject({ title: "Planning", response: "accepted", reminders: [{ method: "notification", minutes: 10 }] });
    expect((await eventsBetween(7, "2027-03-01", "2027-03-02", SG))[0]).toMatchObject({ response: "accepted" });

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(["ann@elsewhere.test"]);
    const reply = await simpleParser(sent[0].raw);
    expect(reply.subject).toMatch(/^Accepted: Planning @ /);
    // Unfolded: long lines continue on the next, after a space.
    const calendar = reply.attachments.find((a) => a.contentType === "text/calendar")!.content.toString().replace(/\r\n[ \t]/g, "");
    expect(calendar).toContain("METHOD:REPLY");
    expect(calendar).toMatch(/ATTENDEE;[^\r\n]*PARTSTAT=ACCEPTED[^\r\n]*:mailto:me@example.test/);
    // Only this guest answers.
    expect(calendar.match(/^ATTENDEE/gm)).toHaveLength(1);

    // Changed to no from the event's card: the answer, and another email.
    expect(await answerEvent(rt, creds, view.stored!.id, "declined")).toEqual({ sent: true });
    expect((await getEvent(7, view.stored!.id, SG)).response).toBe("declined");
    expect((await simpleParser(sent[1].raw)).subject).toMatch(/^Declined: Planning/);
  });

  it("brings a kept invitation up to date, keeping reminders, and the answer only while the time's the same", async () => {
    await actOnInvitation(rt, creds, await partOf(ics("REQUEST"), "REQUEST"), "accepted", null);
    const id = (await viewInvitation(7, await partOf(ics("REQUEST"), "REQUEST"), SG))!.stored!.id;
    const { updateEvent } = await import("../server/calendar.ts");
    await updateEvent(7, id, { reminders: [{ method: "notification", minutes: 30 }] }, SG);

    // The same time, a new place: still yes.
    const place = ics("REQUEST", { seq: 1 }).replace("Room 3", "Room 5");
    const newer = (await viewInvitation(7, await partOf(place, "REQUEST"), SG))!;
    expect(newer).toMatchObject({ newer: true, outdated: false });
    await actOnInvitation(rt, creds, await partOf(place, "REQUEST"), "update", null);
    expect(await getEvent(7, id, SG)).toMatchObject({ location: "Room 5", response: "accepted", reminders: [{ method: "notification", minutes: 30 }] });

    // A new time: asked again.
    const moved = ics("REQUEST", { seq: 2, start: "20270302T010000Z" });
    await actOnInvitation(rt, creds, await partOf(moved, "REQUEST"), "update", null);
    expect(await getEvent(7, id, SG)).toMatchObject({ start: "2027-03-02T09:00", response: "needs-action", reminders: [{ method: "notification", minutes: 30 }] });
    // An older one now is out of date, and can't be answered.
    expect((await viewInvitation(7, await partOf(ics("REQUEST", { seq: 1 }), "REQUEST"), SG))!.outdated).toBe(true);
    await expect(actOnInvitation(rt, creds, await partOf(ics("REQUEST", { seq: 1 }), "REQUEST"), "accepted", null)).rejects.toThrow(/newer version/);
  });

  it("removes a cancelled event, adds a file's event, and won't answer for someone not invited", async () => {
    await actOnInvitation(rt, creds, await partOf(ics("REQUEST"), "REQUEST"), "tentative", null);
    const cancel = await partOf(ics("CANCEL", { seq: 1, status: "CANCELLED" }), "CANCEL");
    expect((await viewInvitation(7, cancel, SG))!.method).toBe("CANCEL");
    await actOnInvitation(rt, creds, cancel, "remove", null);
    expect(await state().selectFrom("events").select("id").execute()).toEqual([]);

    const file = await partOf(ics("PUBLISH").replace("METHOD:PUBLISH\r\n", ""), "PUBLISH");
    expect(file.method).toBe("PUBLISH");
    await actOnInvitation(rt, creds, file, "add", null);
    expect((await eventsBetween(7, "2027-03-01", "2027-03-02", SG)).map((e) => e.title)).toEqual(["Planning"]);
    await expect(actOnInvitation(rt, creds, file, "add", null)).rejects.toThrow(/already/);

    const notMe = await partOf(ics("REQUEST", { attendees: ["ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:bob@elsewhere.test"] }).replace("abc123", "other"), "REQUEST");
    await expect(actOnInvitation(rt, creds, notMe, "accepted", null)).rejects.toThrow(/aren't on its guest list/);
    expect(sent).toHaveLength(1); // the "maybe" above, and nothing since
  });

  it("counts a guest's answer in the event this mailbox organises", async () => {
    const mine = ics("REQUEST", { attendees: ["ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:ann@elsewhere.test"] })
      .replace("ORGANIZER;CN=Ann Lee:mailto:ann@elsewhere.test", "ORGANIZER:mailto:me@example.test");
    await actOnInvitation(rt, creds, await partOf(mine.replace("METHOD:REQUEST", "METHOD:PUBLISH"), "PUBLISH"), "add", primary);
    const reply = ics("REPLY", { attendees: ["ATTENDEE;PARTSTAT=ACCEPTED:mailto:ann@elsewhere.test"] }).replace("ORGANIZER;CN=Ann Lee:mailto:ann@elsewhere.test", "ORGANIZER:mailto:me@example.test");
    const part = await partOf(reply, "REPLY");
    expect((await viewInvitation(7, part, SG))!.replyApplied).toBe(false);
    await actOnInvitation(rt, creds, part, "apply-reply", null);
    const view = (await viewInvitation(7, part, SG))!;
    expect(view.replyApplied).toBe(true);
    expect((await getEvent(7, view.stored!.id, SG)).attendees).toEqual([{ address: "ann@elsewhere.test", name: "", response: "accepted", optional: false }]);
  });
});
