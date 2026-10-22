// Invitations by email (server/invitations.ts) on each state-store engine: reading one from
// a message as calendar apps send it, answering it (kept with the answer, and a REPLY to
// the organiser, caught by a local SMTP server), newer versions, cancellations, files to
// add, a guest's answer counted by the organiser, and events kept in step between
// mailboxes on the same server.
import fs from "node:fs";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import { simpleParser } from "mailparser";
import { SMTPServer } from "smtp-server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createEvent, deleteEvent, eventObject, eventsBetween, getEvent, keepEvent, listCalendars, updateEvent } from "../server/calendar.ts";
import { parseCalendar } from "../server/icalendar.ts";
import { type Endpoint, config, endpointKey } from "../server/config.ts";
import { sha256 } from "../server/crypto.ts";
import type { AccountRuntime } from "../server/imap/runtime.ts";
import { Database, setDatabase } from "../server/db.ts";
import { actOnInvitation, answerEvent, calendarPart, notifyGuests, viewInvitation } from "../server/invitations.ts";
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
    rt = {
      account: {
        id: 7, email: "me@example.test", login: "me@example.test",
        imap: { host: "imap.example.test", port: 993, security: "tls", verify: true },
        smtp: { host: "127.0.0.1", port, security: "none", verify: false, custom: true },
      },
    } as unknown as AccountRuntime;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "viauna-invitations-"));
    if (url) await emptyDatabase(url);
    store = await openState(url, path.join(dir, "state.db"));
    setDatabase(new Database(path.join(dir, "index.db")));
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

  describe("sending them", () => {
    const meeting = { title: "Design review", allDay: false, start: "2027-04-01T10:00", end: "2027-04-01T11:00", zone: SG };
    const mailOf = async (i: number) => {
      const m = await simpleParser(sent[i].raw);
      const ics = m.attachments.find((a) => a.contentType === "text/calendar")!.content.toString().replace(/\r\n[ \t]/g, "");
      return { subject: m.subject, to: sent[i].to, ics };
    };

    it("invites the guests: the mailbox organises it, and each is asked to answer", async () => {
      const ev = await createEvent(7, primary, { ...meeting, guests: [{ address: "Ann@elsewhere.test", name: "Ann Lee" }, { address: "bob@elsewhere.test" }, { address: "me@example.test" }] }, SG);
      expect(ev.organizer).toMatchObject({ address: "me@example.test" });
      expect(ev.attendees.map((a) => [a.address, a.response])).toEqual([["ann@elsewhere.test", "needs-action"], ["bob@elsewhere.test", "needs-action"]]);
      expect((await eventsBetween(7, "2027-04-01", "2027-04-02", SG))[0]).toMatchObject({ hostedWithGuests: true, response: null });
      expect(await notifyGuests(rt, creds, null, (await eventObject(7, ev.id)).row.ics)).toBe(1);
      const mail = await mailOf(0);
      expect(mail.subject).toMatch(/^Invitation: Design review @ /);
      expect(mail.to.sort()).toEqual(["ann@elsewhere.test", "bob@elsewhere.test"]);
      expect(mail.ics).toContain("METHOD:REQUEST");
      expect(mail.ics).toMatch(/ATTENDEE;[^\r\n]*RSVP=TRUE[^\r\n]*:mailto:ann@elsewhere.test/);
      expect(mail.ics).not.toContain("BEGIN:VALARM"); // your reminders are yours
    });

    it("emails a change: invited, updated, and cancelled for anyone taken off; and all when it's deleted", async () => {
      const ev = await createEvent(7, primary, { ...meeting, guests: [{ address: "ann@elsewhere.test" }, { address: "bob@elsewhere.test" }] }, SG);
      const before = (await eventObject(7, ev.id)).row.ics;
      await updateEvent(7, ev.id, { title: "Design review (moved)", guests: [{ address: "ann@elsewhere.test" }, { address: "cy@elsewhere.test" }] }, SG);
      expect(await notifyGuests(rt, creds, before, (await eventObject(7, ev.id)).row.ics)).toBe(3);
      const mails = await Promise.all([0, 1, 2].map(mailOf));
      expect(mails.map((m) => [m.subject?.split(":")[0], m.to])).toEqual([["Invitation", ["cy@elsewhere.test"]], ["Updated invitation", ["ann@elsewhere.test"]], ["Cancelled", ["bob@elsewhere.test"]]]);
      expect(mails[2].ics).toContain("METHOD:CANCEL");
      expect(mails[2].ics).toContain("STATUS:CANCELLED");
      expect(mails[2].ics.match(/^ATTENDEE/gm)).toHaveLength(1);

      sent.length = 0;
      const last = (await eventObject(7, ev.id)).row.ics;
      await deleteEvent(7, ev.id);
      expect(await notifyGuests(rt, creds, last, null)).toBe(1);
      const gone = await mailOf(0);
      expect(gone.to.sort()).toEqual(["ann@elsewhere.test", "cy@elsewhere.test"]);
      expect(gone.ics).toMatch(/SEQUENCE:[1-9]/);
    });

    it("lets only the organiser change who's invited", async () => {
      await actOnInvitation(rt, creds, await partOf(ics("REQUEST"), "REQUEST"), "accepted", null);
      const id = (await eventsBetween(7, "2027-03-01", "2027-03-02", SG))[0].id;
      await expect(updateEvent(7, id, { guests: [{ address: "mallory@elsewhere.test" }] }, SG)).rejects.toThrow(/Only its organiser/);
      // Its organiser isn't this mailbox, so nobody is emailed about a change here.
      sent.length = 0;
      const before = (await eventObject(7, id)).row.ics;
      await updateEvent(7, id, { location: "My desk" }, SG);
      expect(await notifyGuests(rt, creds, before, (await eventObject(7, id)).row.ics)).toBe(0);
    });

    describe("between mailboxes on this server", () => {
      const own: Endpoint = { host: "imap.example.test", port: 993, security: "tls", verify: true };
      const json = endpointKey(own);
      const savedImap = config.imap;
      /** Another mailbox signed in through this server's own mail server, as the organiser (7) is. */
      const mailbox = async (id: number, email: string, login = email, aliases: string[] = []) => {
        const settings = { timeZone: SG, aliases: aliases.map((address) => ({ address, name: "" })) };
        await state().insertInto("accounts").values({ id, login, email, imap: json, imap_hash: sha256(`${json}${id}`), smtp: "{}", settings: JSON.stringify(settings), created_at: 1 }).execute();
        await listCalendars(id, email);
        return { account: { id, email, login, imap: own, smtp: rt.account.smtp } } as unknown as AccountRuntime;
      };
      const kaiOf = (ev: { id: number }) => getEvent(7, ev.id, SG).then((e) => e.attendees.find((a) => a.address === "kai@example.test")?.response);
      const copies = (accountId: number) => eventsBetween(accountId, "2027-03-25", "2027-04-10", SG);
      let ev: { id: number };
      let invite: string;

      beforeEach(async () => {
        config.imap = own;
        await state().updateTable("accounts").set({ imap: json, imap_hash: sha256(json) }).where("id", "=", 7).execute();
        ev = await createEvent(7, primary, { ...meeting, guests: [{ address: "kai@example.test", name: "Kai" }, { address: "ann@elsewhere.test" }] }, SG);
        await notifyGuests(rt, creds, null, (await eventObject(7, ev.id)).row.ics);
        invite = (await mailOf(0)).ics;
        sent.length = 0;
      });

      afterEach(() => {
        config.imap = savedImap;
      });

      /** The organiser changes the event and tells the guests, as Send does. */
      const change = async (patch: Record<string, unknown>) => {
        const before = (await eventObject(7, ev.id)).row.ics;
        await updateEvent(7, ev.id, patch, SG);
        await notifyGuests(rt, creds, before, (await eventObject(7, ev.id)).row.ics);
      };

      it("counts a guest's answer in the organiser's event at once", async () => {
        const kai = await mailbox(9, "kai@example.test");
        await actOnInvitation(kai, creds, await partOf(invite, "REQUEST"), "accepted", null);
        expect(await kaiOf(ev)).toBe("accepted");
      });

      it("counts an answer only from the address the mail server checked, not one typed in or an alias", async () => {
        // Mallory signs in to her own mailbox while typing Kai's address; Max has it as an alias.
        const mallory = await mailbox(10, "kai@example.test", "mallory@example.test");
        await actOnInvitation(mallory, creds, await partOf(invite, "REQUEST"), "declined", null);
        const max = await mailbox(11, "max@example.test", "max@example.test", ["kai@example.test"]);
        await actOnInvitation(max, creds, await partOf(invite, "REQUEST"), "declined", null);
        expect(await kaiOf(ev)).toBe("needs-action");
      });

      it("brings a guest's copy up to date at once, keeping their reminders and answer", async () => {
        const kai = await mailbox(9, "kai@example.test");
        await actOnInvitation(kai, creds, await partOf(invite, "REQUEST"), "accepted", null);
        const [copy] = await copies(9);
        await updateEvent(9, copy.id, { reminders: [{ method: "notification", minutes: 5 }] }, SG);
        await change({ title: "Design review (room change)", location: "Room 7" });
        const now = await getEvent(9, copy.id, SG);
        expect(now).toMatchObject({ title: "Design review (room change)", location: "Room 7", reminders: [{ method: "notification", minutes: 5 }] });
        expect(now.attendees.find((a) => a.address === "kai@example.test")?.response).toBe("accepted");
        await change({ start: "2027-04-02T10:00", end: "2027-04-02T11:00" });
        const moved = await getEvent(9, copy.id, SG);
        expect(moved).toMatchObject({ start: "2027-04-02T10:00", end: "2027-04-02T11:00" });
        // A new time keeps everyone's answers on the organiser's side, so here too.
        expect(moved.attendees.find((a) => a.address === "kai@example.test")?.response).toBe("accepted");
      });

      it("takes a guest's copy out once they're off the guest list, or it's deleted", async () => {
        const kai = await mailbox(9, "kai@example.test");
        const lee = await mailbox(12, "lee@example.test");
        await change({ guests: [{ address: "kai@example.test" }, { address: "lee@example.test" }] });
        const leeInvite = (await mailOf(0)).ics;
        for (const [who, part] of [[kai, invite], [lee, leeInvite]] as const) await actOnInvitation(who, creds, await partOf(part, "REQUEST"), "accepted", null);
        await change({ guests: [{ address: "lee@example.test" }] });
        expect(await copies(9)).toEqual([]);
        expect(await copies(12)).toHaveLength(1);
        const last = (await eventObject(7, ev.id)).row.ics;
        await deleteEvent(7, ev.id);
        await notifyGuests(rt, creds, last, null);
        expect(await copies(12)).toEqual([]);
      });

      it("adds nothing for a guest who hasn't answered, and leaves another organiser's event alone", async () => {
        await mailbox(9, "kai@example.test");
        await change({ title: "Design review (moved)" });
        expect(await copies(9)).toEqual([]);
        // Lee keeps an event with the same UID from someone else: not the organiser's to change.
        await mailbox(12, "lee@example.test");
        const uid = /^UID:(.+)$/m.exec((await eventObject(7, ev.id)).row.ics)![1].trim();
        const foreign = ics("REQUEST", { start: "20270401T020000Z", attendees: ["ATTENDEE;PARTSTAT=ACCEPTED:mailto:lee@example.test"] }).replace("UID:abc123@google.com", `UID:${uid}`);
        await keepEvent(12, parseCalendar(foreign), { calendarId: null });
        await change({ guests: [{ address: "kai@example.test" }, { address: "lee@example.test" }], title: "Taken over" });
        expect((await copies(12)).map((e) => e.title)).toEqual(["Planning"]);
      });
    });
  });
});
