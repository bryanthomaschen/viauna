// Invitations by email (iMIP, RFC 6047): an event someone sends in a message, as a
// text/calendar part with a method (iTIP, RFC 5546). REQUEST invites, or brings a newer
// version; CANCEL calls the event (or one occurrence) off; REPLY is a guest's answer to the
// organiser; a file without one (PUBLISH, or any .ics) is an event to add. What the page
// shows and does is always read from the message on the server, never taken from the page.
//
// Answering keeps the event, with the answer, in a calendar kept here, and sends the
// organiser a REPLY from the mailbox. A newer version replaces the one kept, but your own
// reminders and colour stay, and so does your answer unless its time changed.
import ICAL from "ical.js";
import type { ParsedMail } from "mailparser";
import { buildItip, parseFile } from "./calendar-file.ts";
import {
  CalendarError,
  type EventSummary,
  deleteEvent,
  eventByUid,
  eventObject,
  eventsBetween,
  importEvents,
  keepEvent,
  meOf,
} from "./calendar.ts";
import { VERSION } from "./config.ts";
import type { Credentials } from "./crypto.ts";
import {
  type Component,
  type Person,
  type Property,
  type Response,
  applyPlain,
  instantIn,
  masterEvent,
  myAttendee,
  parseCalendar,
  peopleOf,
  readReminders,
  responseOf,
  setResponse,
  text,
  videoProperty,
} from "./icalendar.ts";
import type { AccountRuntime } from "./imap/runtime.ts";
import { log } from "./log.ts";
import { sendCalendarMail } from "./mail/compose.ts";
import { type RepeatRule, readRule, representative } from "./recurrence.ts";
import { whenText } from "./sender.ts";
import { type Endpoint, verifiedAddress } from "./config.ts";
import { state } from "./state/db.ts";
import { getSettings, reminderZone } from "./settings.ts";

const PRODID = `-//Viauna//Viauna ${VERSION}//EN`;

export type Method = "REQUEST" | "CANCEL" | "REPLY" | "PUBLISH";

/** A message's calendar part: text/calendar, application/ics, or a .ics attachment. */
export interface CalendarPart {
  /** Its place among the message's attachments. */
  index: number;
  text: string;
  /** The method its Content-Type gives, if it does. */
  method: string | null;
}

/** The part an invitation is in: the text/calendar one with a method if there is one (an iMIP message also attaches it as invite.ics), else the first. */
export function calendarPart(parsed: ParsedMail): CalendarPart | null {
  const found: CalendarPart[] = [];
  for (const [index, a] of parsed.attachments.entries()) {
    const type = a.contentType.toLowerCase();
    if (type !== "text/calendar" && type !== "application/ics" && !/\.ics$/i.test(a.filename ?? "")) continue;
    if (a.content.length > 1024 * 1024) continue;
    const params = (a.headers.get("content-type") as { params?: Record<string, string> } | undefined)?.params ?? {};
    let text: string;
    try {
      text = new TextDecoder(params.charset || "utf-8").decode(a.content);
    } catch {
      text = a.content.toString("utf8");
    }
    found.push({ index, text, method: params.method?.toUpperCase() ?? null });
  }
  return found.find((p) => p.method) ?? found[0] ?? null;
}

interface Itip {
  method: Method;
  uid: string;
  /** The event's object: what the message has of that UID (the event, or one occurrence of it). */
  root: Component;
  /** Other events in the same file (a .ics of several). */
  more: number;
}

/** Reads an invitation; null if the part isn't one Viauna can read. */
export function readItip(part: CalendarPart): Itip | null {
  let file: ReturnType<typeof parseFile>;
  try {
    file = parseFile(part.text, PRODID);
  } catch {
    return null;
  }
  const first = file.events[0];
  if (!first) return null;
  const written = /^METHOD:([A-Za-z-]+)\s*$/im.exec(part.text)?.[1]?.toUpperCase();
  const method = (part.method ?? written ?? "PUBLISH") as Method;
  return { method: (["REQUEST", "CANCEL", "REPLY"] as const).find((m) => m === method) ?? "PUBLISH", uid: first.uid, root: first.root, more: file.events.length - 1 };
}

const SEQ = (e: Component) => Number(e.getFirstPropertyValue("sequence") ?? 0) || 0;

/** The occurrence a REQUEST or CANCEL is about, if only one (its RECURRENCE-ID, as written). */
function occurrenceOf(root: Component): string | null {
  const events = root.getAllSubcomponents("vevent");
  if (events.some((e) => !e.hasProperty("recurrence-id"))) return null;
  const rid = events[0]?.getFirstProperty("recurrence-id");
  return rid ? String(rid.toICALString().split(":").pop()) : null;
}

/** Whether two versions have their first occurrence at the same times. */
function sameTimes(a: Component, b: Component): boolean {
  const t = (root: Component) => {
    const e = masterEvent(root);
    return e ? ["dtstart", "dtend", "duration", "rrule"].map((p) => e.getFirstProperty(p)?.toICALString() ?? "").join("|") : "";
  };
  return t(a) === t(b);
}

/**
 * Whether two versions say the same in what the organiser decides: times, repeats, title,
 * place, description, status and who's invited (not anyone's answer, nor your own
 * reminders). A change to any of these may come without a new SEQUENCE (RFC 5546 asks for
 * one only for some), so a version that differs in them is newer.
 */
function sameVersion(a: Component, b: Component): boolean {
  const v = (root: Component) =>
    root.getAllSubcomponents("vevent").map((e) => [
      ...["recurrence-id", "dtstart", "dtend", "duration", "rrule", "rdate", "exdate", "summary", "location", "description", "status"]
        .map((p) => e.getAllProperties(p).map((x) => x.toICALString()).join(";")),
      peopleOf(e).attendees.map((x) => x.address).sort().join(","),
    ].join("|")).sort().join("\n");
  return v(a) === v(b);
}

/** Whether an incoming version is newer than the one kept: a higher SEQUENCE, or the same with other details. */
const isNewer = (incoming: Component, kept: Component) =>
  SEQ(masterEvent(incoming)!) > SEQ(masterEvent(kept)!) || (SEQ(masterEvent(incoming)!) === SEQ(masterEvent(kept)!) && !sameVersion(incoming, kept));

// ---------------------------------------------------------------- what the page shows

export interface InvitationView {
  method: Method;
  title: string;
  allDay: boolean;
  /** As an event's summary has them: dates for all-day, else ISO instants. The next occurrence, for one that repeats. */
  start: string;
  end: string;
  repeat: RepeatRule | null;
  location: string;
  video: string | null;
  description: string;
  organizer: Person | null;
  attendees: Person[];
  /** This mailbox among the guests, if it is. */
  you: Person | null;
  /** This mailbox organises it. */
  youOrganize: boolean;
  /** For one occurrence of a repeating event. */
  occurrence: string | null;
  /** Other events in the same file. */
  more: number;
  /** The event as it is in a calendar here, if it is. */
  stored: { id: number; calendarId: number; response: Response | null; sequence: number } | null;
  /** Older than the version kept. */
  outdated: boolean;
  /** Newer than the version kept, so it can be updated. */
  newer: boolean;
  /** For a REPLY to an event this mailbox organises: whether it's already counted there. */
  replyApplied: boolean;
  /** This mailbox's busy events at the same time. */
  clashes: EventSummary[];
}

/** What a message's invitation is, as the page shows it, in `zone`. */
export async function viewInvitation(accountId: number, part: CalendarPart, zone: string): Promise<InvitationView | null> {
  const itip = readItip(part);
  if (!itip) return null;
  const me = await meOf(accountId);
  const master = masterEvent(itip.root)!;
  const people = peopleOf(master);
  const occ = representative(itip.root, Date.now(), zone);
  const iso = (m: NonNullable<typeof occ>["start"]) => (m.kind === "date" ? m.date : new Date(instantIn(m, zone)).toISOString());
  const row = await eventByUid(accountId, itip.uid);
  const storedRoot = row ? parseCalendar(row.ics) : null;
  const storedSeq = storedRoot ? SEQ(masterEvent(storedRoot)!) : 0;
  const view: InvitationView = {
    method: itip.method,
    title: text(master, "summary"),
    allDay: occ?.start.kind === "date",
    start: occ ? iso(occ.start) : "",
    end: occ ? iso(occ.end) : "",
    repeat: readRule(master, itip.root, zone),
    location: text(master, "location"),
    video: (videoProperty(master)?.getFirstValue() as string | undefined) ?? null,
    description: text(master, "description").slice(0, 2000),
    organizer: people.organizer,
    attendees: people.attendees,
    you: people.attendees.find((p) => me.has(p.address)) ?? null,
    youOrganize: !!people.organizer && me.has(people.organizer.address),
    occurrence: occurrenceOf(itip.root),
    more: itip.more,
    stored: row && storedRoot ? { id: row.id, calendarId: row.calendar_id, response: responseOf(masterEvent(storedRoot)!, me), sequence: storedSeq } : null,
    outdated: !!storedRoot && SEQ(master) < storedSeq,
    newer: !!storedRoot && isNewer(itip.root, storedRoot),
    replyApplied: false,
    clashes: [],
  };
  // Your answer as your calendar has it, not as the invitation was sent.
  if (view.you && view.stored?.response) {
    const answer = view.stored.response;
    view.you = { ...view.you, response: answer };
    view.attendees = view.attendees.map((p) => (p.address === view.you!.address ? { ...p, response: answer } : p));
  }
  if (itip.method === "REPLY" && storedRoot) {
    const guest = people.attendees[0];
    const kept = guest && peopleOf(masterEvent(storedRoot)!).attendees.find((a) => a.address === guest.address);
    view.replyApplied = !kept || kept.response === guest.response;
  }
  if (occ && !view.allDay && itip.method !== "CANCEL" && itip.method !== "REPLY") {
    const from = new Date(Date.parse(view.start) - 86_400_000).toISOString().slice(0, 10);
    const to = new Date(Date.parse(view.end) + 2 * 86_400_000).toISOString().slice(0, 10);
    const start = Date.parse(view.start);
    const end = Date.parse(view.end);
    try {
      view.clashes = (await eventsBetween(accountId, from, to, zone)).filter(
        (e) => !e.allDay && e.busy && e.response !== "declined" && e.id !== row?.id && Date.parse(e.start) < end && Date.parse(e.end) > start,
      );
    } catch {
      view.clashes = [];
    }
  }
  return view;
}

// ---------------------------------------------------------------- answering

const VERBS: Record<"accepted" | "declined" | "tentative", [string, string]> = {
  accepted: ["Accepted", "has accepted"],
  declined: ["Declined", "has declined"],
  tentative: ["Tentatively accepted", "has tentatively accepted"],
};

const clone = (c: Component) => new ICAL.Component(JSON.parse(JSON.stringify(c.toJSON())));
const cloneProp = (p: Property) => new ICAL.Property(JSON.parse(JSON.stringify(p.toJSON())));

/** The REPLY to an event (or the occurrence it's about): its times, title and organiser, and only this guest, with their answer (RFC 5546 3.2.3). */
function replyObject(root: Component, me: Set<string>, response: Response): Component {
  const out = new ICAL.Component(["vcalendar", [], []]);
  for (const tz of root.getAllSubcomponents("vtimezone")) out.addSubcomponent(clone(tz));
  const source = masterEvent(root)!;
  const event = new ICAL.Component("vevent");
  for (const name of ["uid", "sequence", "dtstart", "dtend", "duration", "recurrence-id", "summary", "organizer"]) {
    const p = source.getFirstProperty(name);
    if (p) event.addProperty(cloneProp(p));
  }
  const mine = myAttendee(source, me);
  if (mine) {
    const attendee = cloneProp(mine);
    attendee.setParameter("partstat", response.toUpperCase());
    attendee.removeParameter("rsvp");
    event.addProperty(attendee);
  }
  event.updatePropertyWithValue("dtstamp", ICAL.Time.fromJSDate(new Date(), true));
  out.addSubcomponent(event);
  return out;
}

/** Emails the organiser this mailbox's answer, unless it organises the event itself, or none is asked for (RSVP=FALSE). */
async function sendReply(rt: AccountRuntime, creds: Credentials, root: Component, me: Set<string>, response: "accepted" | "declined" | "tentative"): Promise<boolean> {
  const master = masterEvent(root)!;
  const { organizer } = peopleOf(master);
  const mine = myAttendee(master, me);
  if (!organizer || me.has(organizer.address) || !mine) return false;
  if (String(mine.getParameter("rsvp") ?? "").toUpperCase() === "FALSE") return false;
  const settings = await getSettings(rt.account.id);
  const who = settings.name || rt.account.email;
  const zone = await reminderZone(rt.account.id);
  const occ = representative(root, Date.now(), zone);
  const iso = (m: NonNullable<typeof occ>["start"]) => (m.kind === "date" ? m.date : new Date(instantIn(m, zone)).toISOString());
  const title = text(master, "summary") || "(No title)";
  const when = occ ? whenText({ allDay: occ.start.kind === "date", start: iso(occ.start), end: iso(occ.end), zone }) : "";
  const [verb, says] = VERBS[response];
  await sendCalendarMail(rt, creds, {
    to: [{ address: organizer.address, name: organizer.name || undefined }],
    subject: `${verb}: ${title}${when ? ` @ ${when}` : ""}`,
    text: `${who} ${says} this invitation.\n\n${title}\n${when}\n`,
    html: `<p>${escape(who)} ${says} this invitation.</p><p><b>${escape(title)}</b><br>${escape(when)}</p>`,
    method: "REPLY",
    ics: buildItip("REPLY", replyObject(root, me, response), PRODID),
  });
  return true;
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A newer version in place of the kept one: your reminders and colour stay, and your answer unless its time changed. */
function merged(incoming: Component, kept: Component | null, me: Set<string>): Component {
  const root = clone(incoming);
  if (!kept) return root;
  const keptMaster = masterEvent(kept)!;
  const master = masterEvent(root)!;
  applyPlain(master, { reminders: readReminders(keptMaster) });
  const color = keptMaster.getFirstPropertyValue("color");
  if (color) master.updatePropertyWithValue("color", color);
  const answer = responseOf(keptMaster, me);
  if (answer && answer !== "needs-action" && responseOf(master, me) === "needs-action" && sameTimes(incoming, kept)) {
    for (const e of root.getAllSubcomponents("vevent")) setResponse(e, me, answer);
  }
  return root;
}

/** An update to one occurrence: the kept series with that occurrence's VEVENT replaced. */
function withOccurrence(kept: Component, incoming: Component): Component {
  const root = clone(kept);
  const key = (e: Component) => e.getFirstProperty("recurrence-id")?.toICALString().split(":").pop() ?? "";
  for (const ov of incoming.getAllSubcomponents("vevent")) {
    for (const old of root.getAllSubcomponents("vevent")) if (old.hasProperty("recurrence-id") && key(old) === key(ov)) root.removeSubcomponent(old);
    root.addSubcomponent(clone(ov));
  }
  for (const tz of incoming.getAllSubcomponents("vtimezone")) {
    const id = tz.getFirstPropertyValue("tzid");
    if (!root.getAllSubcomponents("vtimezone").some((t) => t.getFirstPropertyValue("tzid") === id)) root.addSubcomponent(clone(tz));
  }
  return root;
}

export type InvitationAction = "accepted" | "declined" | "tentative" | "add" | "update" | "remove" | "apply-reply";

/**
 * Does what the page asked with a message's invitation: answer it (keeping it with the
 * answer, and telling the organiser); add a file's event; bring a kept event up to date
 * with a newer version; remove one that's been cancelled; or, as its organiser, count a
 * guest's answer. Returns whether an email went, for the page to say so.
 */
export async function actOnInvitation(rt: AccountRuntime, creds: Credentials, part: CalendarPart, action: InvitationAction, calendarId: number | null): Promise<{ sent: boolean }> {
  const accountId = rt.account.id;
  const itip = readItip(part);
  if (!itip) throw new CalendarError("That isn't an invitation Viauna can read.");
  const me = await meOf(accountId);
  const row = await eventByUid(accountId, itip.uid);
  const kept = row ? parseCalendar(row.ics) : null;
  const target = row ? { id: row.id } : { calendarId: calendarId ?? (await getSettings(accountId)).invitationCalendar };

  if (action === "accepted" || action === "declined" || action === "tentative") {
    if (itip.method !== "REQUEST") throw new CalendarError("Only an invitation can be answered.");
    if (!myAttendee(masterEvent(itip.root)!, me)) throw new CalendarError("You aren't on its guest list, so you can't answer it. Add it to your calendar instead.");
    if (kept && SEQ(masterEvent(itip.root)!) < SEQ(masterEvent(kept)!)) throw new CalendarError("There's a newer version of this invitation. Answer that one.");
    let root = occurrenceOf(itip.root) && kept ? withOccurrence(kept, itip.root) : merged(itip.root, kept, me);
    if (!kept) root = withUsualReminders(root, await getSettings(accountId));
    for (const e of root.getAllSubcomponents("vevent")) setResponse(e, me, action);
    await keepEvent(accountId, root, target);
    const sent = await sendReply(rt, creds, itip.root, me, action);
    await answerOnThisServer(rt, itip.root, action);
    return { sent };
  }
  if (action === "add") {
    if (kept) throw new CalendarError("It's in your calendar already.");
    if (itip.method === "PUBLISH") {
      await importEvents(accountId, target.calendarId ?? (await getSettings(accountId)).invitationCalendar ?? "new", part.text);
    } else {
      await keepEvent(accountId, withUsualReminders(clone(itip.root), await getSettings(accountId)), target);
    }
    return { sent: false };
  }
  if (action === "update") {
    if (!kept || !row) throw new CalendarError("It isn't in your calendar.");
    if (itip.method === "PUBLISH" || itip.method === "REQUEST") {
      if (SEQ(masterEvent(itip.root)!) < SEQ(masterEvent(kept)!)) throw new CalendarError("Your calendar has a newer version.");
      await keepEvent(accountId, occurrenceOf(itip.root) ? withOccurrence(kept, itip.root) : merged(itip.root, kept, me), { id: row.id });
      return { sent: false };
    }
    throw new CalendarError("There's nothing in this message to update it with.");
  }
  if (action === "remove") {
    if (itip.method !== "CANCEL") throw new CalendarError("Only a cancelled event is removed from here.");
    if (!row) return { sent: false };
    const occurrence = occurrenceOf(itip.root);
    await deleteEvent(accountId, row.id, occurrence ?? undefined, occurrence ? "this" : undefined);
    return { sent: false };
  }
  if (action === "apply-reply") {
    if (itip.method !== "REPLY" || !kept || !row) throw new CalendarError("There's no answer here for an event in your calendar.");
    await keepEvent(accountId, applyReply(kept, itip.root, me), { id: row.id });
    return { sent: false };
  }
  throw new CalendarError("Unknown action.");
}

/**
 * A guest's answer counted in the event this mailbox organises: their PARTSTAT set where
 * they're a guest (the series, or the occurrence answered). An answer to an older version
 * than the one kept is left out.
 */
export function applyReply(kept: Component, reply: Component, me: Set<string>): Component {
  const root = clone(kept);
  const keptMaster = masterEvent(root)!;
  const { organizer } = peopleOf(keptMaster);
  if (!organizer || !me.has(organizer.address)) throw new CalendarError("You don't organise this event, so its answers aren't yours to count.");
  const replyEvent = masterEvent(reply)!;
  if (SEQ(replyEvent) < SEQ(keptMaster)) throw new CalendarError("That answer is to an earlier version of the event.");
  const guest = peopleOf(replyEvent).attendees[0];
  if (!guest || !guest.response) throw new CalendarError("That answer doesn't say who's answering.");
  const occurrence = occurrenceOf(reply);
  let found = false;
  for (const e of root.getAllSubcomponents("vevent")) {
    const rid = e.getFirstProperty("recurrence-id")?.toICALString().split(":").pop() ?? null;
    if (occurrence !== null && rid !== occurrence) continue;
    if (setResponse(e, new Set([guest.address]), guest.response)) found = true;
  }
  if (!found) throw new CalendarError(`${guest.address} isn't one of the event's guests.`);
  return root;
}

/** A new event from an invitation gets the mailbox's usual reminders, unless it brought its own. */
function withUsualReminders(root: Component, settings: Awaited<ReturnType<typeof getSettings>>): Component {
  const master = masterEvent(root)!;
  if (readReminders(master).length) return root;
  const allDay = master.getFirstProperty("dtstart")?.getFirstValue() instanceof ICAL.Time && (master.getFirstPropertyValue("dtstart") as InstanceType<typeof ICAL.Time>).isDate;
  applyPlain(master, { reminders: allDay ? settings.allDayReminders : settings.reminders });
  return root;
}

/**
 * Answers an invitation kept in a calendar (from the event's card): the answer in the
 * event, and an email to the organiser.
 */
export async function answerEvent(rt: AccountRuntime, creds: Credentials, eventId: number, response: unknown): Promise<{ sent: boolean }> {
  if (response !== "accepted" && response !== "declined" && response !== "tentative") throw new CalendarError("Say yes, no or maybe.");
  const accountId = rt.account.id;
  const me = await meOf(accountId);
  const { row, root } = await eventObject(accountId, eventId);
  if (!myAttendee(masterEvent(root)!, me)) throw new CalendarError("You aren't one of this event's guests.");
  for (const e of root.getAllSubcomponents("vevent")) setResponse(e, me, response);
  await keepEvent(accountId, root, { id: row.id });
  const sent = await sendReply(rt, creds, root, me, response);
  await answerOnThisServer(rt, root, response);
  return { sent };
}

/** This server's mailboxes whose verified address is `address`, but for the one acting. */
async function mailboxesHere(address: string, except: number): Promise<number[]> {
  const rows = await state().selectFrom("accounts").select(["id", "login", "email", "imap"]).where("email", "=", address).execute();
  return rows.filter((a) => a.id !== except && verifiedAddress({ ...a, imap: JSON.parse(a.imap) as Endpoint }) === address).map((a) => a.id);
}

/**
 * When the organiser is a mailbox on this server too, the answer is counted in their event
 * at once, without waiting for the email. Only as the address this server's mail server
 * vouched for (an alias is whatever someone typed in), and only the answer: nothing goes
 * into anyone's calendar unasked.
 */
async function answerOnThisServer(rt: AccountRuntime, root: Component, response: Response): Promise<void> {
  const mine = verifiedAddress(rt.account);
  const master = masterEvent(root)!;
  const { organizer } = peopleOf(master);
  if (!mine || !organizer || !myAttendee(master, new Set([mine]))) return;
  const uid = String(master.getFirstPropertyValue("uid") ?? "");
  for (const host of await mailboxesHere(organizer.address, rt.account.id)) {
    const row = await eventByUid(host, uid);
    if (!row) continue;
    try {
      await keepEvent(host, applyReply(parseCalendar(row.ics), replyObject(root, new Set([mine]), response), await meOf(host)), { id: row.id });
    } catch (err) {
      log.warn("couldn't count an answer in its organiser's event", { organizer: host, error: (err as Error).message });
    }
  }
}

/**
 * The organiser's change, made at once in the calendars of guests who are mailboxes on
 * this server too and keep the event (because they answered it): the new version, with
 * their reminders, colour and answer kept as Update your calendar keeps them; or, once
 * it's cancelled or they're off the guest list, out of their calendar. A guest who hasn't
 * answered has only the email: nothing goes into anyone's calendar unasked. Only from the
 * organiser's verified address, and only into a kept event with the same organiser.
 */
async function updateGuestsOnThisServer(rt: AccountRuntime, organizer: string, uid: string, after: Component | null, was: Map<string, Person>, now: Map<string, Person>): Promise<void> {
  if (verifiedAddress(rt.account) !== organizer) return;
  for (const address of new Set([...was.keys(), ...now.keys()])) {
    for (const guest of await mailboxesHere(address, rt.account.id)) {
      const row = await eventByUid(guest, uid);
      if (!row) continue;
      const kept = parseCalendar(row.ics);
      if (peopleOf(masterEvent(kept)!).organizer?.address !== organizer) continue;
      try {
        if (after && now.has(address)) await keepEvent(guest, merged(after, kept, await meOf(guest)), { id: row.id });
        else await deleteEvent(guest, row.id);
      } catch (err) {
        log.warn("couldn't bring a guest's copy of an event up to date", { guest, error: (err as Error).message });
      }
    }
  }
}

// ---------------------------------------------------------------- sending invitations

/** The guests of an object, on the event and its occurrences changed on their own, not the organiser. */
function guestsOf(root: Component | null, me: Set<string>): Map<string, Person> {
  const out = new Map<string, Person>();
  for (const e of root?.getAllSubcomponents("vevent") ?? []) for (const p of peopleOf(e).attendees) if (!me.has(p.address)) out.set(p.address, p);
  return out;
}

/** A version for guests to cancel: STATUS:CANCELLED, a new SEQUENCE, and only the guests named. */
function cancellation(root: Component, guests: string[] | null): Component {
  const out = clone(root);
  for (const e of out.getAllSubcomponents("vevent")) {
    e.updatePropertyWithValue("status", "CANCELLED");
    e.updatePropertyWithValue("sequence", SEQ(e) + 1);
    e.updatePropertyWithValue("dtstamp", ICAL.Time.fromJSDate(new Date(), true));
    if (guests) for (const a of e.getAllProperties("attendee")) if (!guests.includes(String(a.getFirstValue()).replace(/^mailto:/i, "").toLowerCase())) e.removeProperty(a);
    e.removeAllSubcomponents("valarm");
  }
  return out;
}

/**
 * Emails an event's guests after the mailbox, its organiser, changed it: the new version to
 * everyone invited (an invitation to those new to it, an update to the rest), and a
 * cancellation to anyone taken off, or to all if it's gone; and the same change made at
 * once for guests on this server who keep it (updateGuestsOnThisServer). `before` and
 * `after` are the event's iCalendar text before and after (null: not there). Returns how
 * many emails went.
 */
export async function notifyGuests(rt: AccountRuntime, creds: Credentials, before: string | null, after: string | null): Promise<number> {
  const me = await meOf(rt.account.id);
  const b = before ? parseCalendar(before) : null;
  const a = after ? parseCalendar(after) : null;
  const main = a ?? b;
  if (!main) return 0;
  const { organizer } = peopleOf(masterEvent(main)!);
  if (!organizer || !me.has(organizer.address)) return 0;
  const was = guestsOf(b, me);
  const now = guestsOf(a, me);
  const settings = await getSettings(rt.account.id);
  const who = settings.name || rt.account.email;
  const zone = await reminderZone(rt.account.id);
  const describe = (root: Component) => {
    const master = masterEvent(root)!;
    const occ = representative(root, Date.now(), zone);
    const iso = (m: NonNullable<typeof occ>["start"]) => (m.kind === "date" ? m.date : new Date(instantIn(m, zone)).toISOString());
    return {
      title: text(master, "summary") || "(No title)",
      when: occ ? whenText({ allDay: occ.start.kind === "date", start: iso(occ.start), end: iso(occ.end), zone }) : "",
      location: text(master, "location"),
      video: (videoProperty(master)?.getFirstValue() as string | undefined) ?? null,
      description: text(master, "description").slice(0, 5000),
    };
  };
  const mail = async (to: Person[], root: Component, method: "REQUEST" | "CANCEL", kind: "invited" | "updated" | "cancelled") => {
    if (!to.length) return 0;
    const d = describe(root);
    const verb = { invited: "Invitation", updated: "Updated invitation", cancelled: "Cancelled" }[kind];
    const says = { invited: "has invited you to", updated: "has changed", cancelled: "has cancelled" }[kind];
    const lines = [d.when, d.location, d.video ? `Video call: ${d.video}` : ""].filter(Boolean);
    await sendCalendarMail(rt, creds, {
      to: to.map((p) => ({ address: p.address, name: p.name || undefined })),
      subject: `${verb}: ${d.title}${d.when ? ` @ ${d.when}` : ""}`,
      text: `${who} ${says} ${d.title}.\n\n${lines.join("\n")}\n${d.description ? `\n${d.description}\n` : ""}`,
      html: [
        `<p>${escape(who)} ${says} <b>${escape(d.title)}</b>.</p>`,
        `<p>${lines.map((l) => escape(l)).join("<br>")}</p>`,
        d.video ? `<p><a href="${escape(d.video)}">Join the video call</a></p>` : "",
        d.description ? `<p style="white-space:pre-wrap">${escape(d.description)}</p>` : "",
      ].join("\n"),
      method,
      ics: buildItip(method, root, PRODID),
    });
    return 1;
  };
  let sent = 0;
  // Your reminders are yours: guests get the event without them.
  const forGuests = a ? clone(a) : null;
  for (const e of forGuests?.getAllSubcomponents("vevent") ?? []) e.removeAllSubcomponents("valarm");
  if (a && forGuests) {
    const fresh = [...now.values()].filter((p) => !was.has(p.address));
    const known = [...now.values()].filter((p) => was.has(p.address));
    sent += await mail(fresh, forGuests, "REQUEST", "invited");
    sent += await mail(known, forGuests, "REQUEST", "updated");
    const gone = [...was.values()].filter((p) => !now.has(p.address));
    if (gone.length && b) sent += await mail(gone, cancellation(b, gone.map((p) => p.address)), "CANCEL", "cancelled");
  } else if (b) {
    sent += await mail([...was.values()], cancellation(b, null), "CANCEL", "cancelled");
  }
  await updateGuestsOnThisServer(rt, organizer.address, String(masterEvent(main)!.getFirstPropertyValue("uid") ?? ""), forGuests, was, now);
  return sent;
}
