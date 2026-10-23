// The event editor, opened from the calendar, from an event's card, or from an email
// ("Create event"); the question of which occurrences a change to a repeating event is
// for; the dialog that names and colours a calendar; and those that add calendars from a
// file or from the web. Times are edited as dates and
// wall-clock times: in the calendar's time zone, or in the event's own zones when it has
// them or they're set here. Kept apart from Calendar.tsx so that opening it from a
// message doesn't load the calendar grid.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Globe, KeyRound, RefreshCw, Trash2 } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import { ui, useAccount } from "../lib/account";
import { api } from "../lib/api";
import {
  COLORS,
  WEEKDAYS,
  addDays,
  addMinutes,
  askScope,
  askSend,
  calendarsQuery,
  colorLabel,
  dayName,
  instantToWall,
  nextHalfHour,
  nthOf,
  repeatPresets,
  repeatText,
  sameRule,
  useCalendarZone,
  wallToMs,
  weekdayOf,
  zoneOffset,
} from "../lib/calendar";
import { useConfig } from "../lib/config";
import { longDate, relative } from "../lib/format";
import { toast } from "../lib/store";
import type { CalendarInfo, EventInput, RepeatRule, Scope, SecretMode } from "../lib/types";
import { Modal } from "./common";
import { Guests } from "./Invitation";
import { RecipientField } from "./RecipientField";
import { RemindersField } from "./Reminders";

type Draft = EventInput & {
  calendarId: number | null;
  /** The time zone controls are showing, and the zones they hold are what's saved. */
  zonesOpen: boolean;
};

const blank = (start: string, end: string, zone: string): Draft => ({
  title: "", allDay: false, start, end, zone, endZone: null, location: "", description: "", busy: true, color: null, video: null,
  repeat: null, calendarId: null, zonesOpen: false,
});

/** The zones the browser knows, for the time-zone lists. */
const ZONES: string[] = (() => {
  try {
    return (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    return [];
  }
})();

/** Undo for a change just made to the calendar, offered on its notice. */
export function undoable(index: number, refresh: () => void) {
  return (token: string) => ({
    label: "Undo",
    run: () =>
      void api
        .undoCalendar(index, token)
        .then(refresh)
        .catch((err: Error) => toast(err.message, { error: true })),
  });
}

/** Deletes an event; for one that repeats, asks first which occurrences. */
export async function deleteEvent(index: number, e: { id: number; occurrence: string | null; recurring: boolean; hostedWithGuests?: boolean }, refresh: () => void) {
  let scope: Scope | undefined;
  if (e.recurring) {
    const asked = await askScope("delete");
    if (!asked) return;
    scope = asked;
  }
  // An event you organise with guests: tell them, or not.
  const notify = e.hostedWithGuests ? await askSend("delete") : false;
  if (notify === null) return;
  try {
    const { undo, emailed } = await api.deleteEvent(index, e.id, e.recurring ? e.occurrence : null, scope, notify);
    refresh();
    toast(emailed ? "Event deleted. The guests have been told." : "Event deleted.", { action: undoable(index, refresh)(undo) });
  } catch (err) {
    toast((err as Error).message, { error: true });
  }
}

/** Adds an event (from `initial`) or edits one (`id`, and for one that repeats, the occurrence it was opened from). */
export function EventDialog({ id, occurrence, initial }: { id?: number; occurrence?: string | null; initial?: Partial<EventInput> & { calendarId?: number } }) {
  const acct = useAccount();
  const client = useQueryClient();
  const zone = useCalendarZone();
  const minutes = acct.settings?.eventMinutes ?? 60;
  const close = () => ui.set((s) => ({ ...s, eventDialog: null }));
  const calendars = useQuery(calendarsQuery(acct.index));
  const existing = useQuery({
    queryKey: ["event", acct.index, id, zone, occurrence ?? null],
    queryFn: () => api.event(acct.index, id!, zone, occurrence),
    enabled: id !== undefined,
    staleTime: 0,
  });
  const [draft, setDraft] = useState<Draft | null>(() => {
    if (id !== undefined) return null;
    const start = initial?.start ?? nextHalfHour(zone);
    const end = initial?.end ?? (initial?.allDay ? addDays(start, 1) : addMinutes(start, minutes, zone));
    // A new event starts with the mailbox's usual reminders, unless it's a copy.
    const reminders = initial?.reminders ?? (initial?.allDay ? acct.settings?.allDayReminders : acct.settings?.reminders) ?? [];
    return { ...blank(start, end, zone), ...initial, start, end, zone: initial?.allDay ? null : zone, calendarId: initial?.calendarId ?? null, reminders };
  });
  const [customOpen, setCustomOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const loaded = existing.data?.event;
  const mine = acct.identities.map((i) => i.address.toLowerCase());
  // Its guest list is the organiser's: yours to change if you organise it, or it's new.
  const hosting = !loaded || !loaded.organizer || mine.includes(loaded.organizer.address);
  // An event from the web is shown, not changed; only calendars whose events are kept here can take one.
  const readOnly = !!loaded?.readOnly;
  const list = (calendars.data?.calendars ?? []).filter((c) => readOnly || !c.readOnly);
  const d: Draft | null = draft ?? (loaded ? fromLoaded(loaded, zone) : null);
  const calendarId = d?.calendarId ?? list.find((c) => c.primary)?.id ?? list[0]?.id ?? null;
  const calendar = list.find((c) => c.id === calendarId);
  const set = (patch: Partial<Draft>) => d && setDraft({ ...d, ...patch });

  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["events", acct.index] });
    if (id !== undefined) void client.invalidateQueries({ queryKey: ["event", acct.index, id] });
  };

  if (!d) {
    return (
      <Modal open onClose={close} title="Edit event">
        {existing.error ? <p className="form-error">{existing.error.message}</p> : <div className="empty"><div className="spinner" /></div>}
      </Modal>
    );
  }

  const startZone = d.zone ?? zone;
  const endZone = d.endZone ?? startZone;
  const date = (v: string) => v.slice(0, 10);
  const time = (v: string) => v.slice(11, 16);
  // An all-day event's end is the day after its last; the form shows the last day.
  const lastDay = d.allDay ? addDays(d.end, -1) : date(d.end);
  const length = d.allDay ? 0 : wallToMs(d.end, endZone) - wallToMs(d.start, startZone);
  const backwards = d.allDay ? d.end <= d.start : length < 0;

  /** A new start keeps the event's length, as in Google Calendar. */
  const moveStart = (start: string) => {
    if (d.allDay) {
      const days = Math.round((Date.parse(d.end) - Date.parse(d.start)) / 86_400_000);
      set({ start, end: addDays(start, days) });
    } else {
      set({ start, end: instantToWall(wallToMs(start, startZone) + Math.max(0, length), endZone) });
    }
  };
  const setAllDay = (allDay: boolean) => {
    // A reminder so long before a time means nothing for a whole day, and the other way
    // round: the event gets the usual ones for its new kind.
    const reminders = (allDay ? acct.settings?.allDayReminders : acct.settings?.reminders) ?? [];
    if (allDay) set({ allDay, start: date(d.start), end: addDays(date(d.end) < date(d.start) ? date(d.start) : date(d.end), 1), reminders });
    else {
      const start = `${date(d.start)}T09:00`;
      set({ allDay, zone: startZone, start, end: addMinutes(start, minutes, startZone), reminders });
    }
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (backwards || calendarId === null) return;
    const input: EventInput = {
      title: d.title, allDay: d.allDay, start: d.start, end: d.end, zone: d.allDay ? null : startZone, endZone: d.allDay || endZone === startZone ? null : endZone,
      location: d.location, description: d.description, busy: d.busy, color: d.color, video: d.video?.trim() || null, repeat: d.repeat,
      reminders: d.reminders ?? [],
      ...(hosting ? { guests: d.guests ?? [] } : {}),
    };
    // With guests, before or now: email them, or not.
    const before = loaded?.attendees.length ?? 0;
    if (hosting && ((d.guests?.length ?? 0) > 0 || before > 0)) {
      const send = await askSend(id === undefined || !before ? "invite" : "change");
      if (send === null) return;
      input.notify = send;
    }
    let scope: Scope | undefined;
    if (loaded?.recurring) {
      const asked = await askScope("change", !sameRule(d.repeat, loaded.repeat));
      if (!asked) return;
      scope = asked;
    }
    setBusy(true);
    setError("");
    try {
      if (id === undefined) {
        const { emailed } = await api.createEvent(acct.index, calendarId, input, zone);
        toast(emailed ? "Event saved. Invitations sent." : "Event saved.");
      } else {
        // The editor's times are in the zones it shows: say so, so they're kept.
        const setZones = d.zonesOpen || startZone !== zone;
        const { undo, emailed } = await api.updateEvent(acct.index, id, { ...input, calendarId, occurrence: loaded?.occurrence ?? null, scope, setZones }, zone);
        toast(emailed ? "Event saved. The guests have been told." : "Event saved.", { action: undoable(acct.index, refresh)(undo) });
      }
      refresh();
      close();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const duplicate = () => {
    if (!loaded) return;
    const { id: _id, created: _c, updated: _u, eventZone: _z, eventEndZone: _ez, occurrence: _o, recurring: _r, readOnly: _ro, calendarId: _cal, ...copy } = loaded;
    ui.set((s) => ({ ...s, eventDialog: { initial: { ...copy, repeat: copy.repeat?.custom ? null : copy.repeat, title: copy.title } } }));
  };

  return (
    <Modal open onClose={close} title={id === undefined ? "New event" : readOnly ? "Event" : "Edit event"}>
      <form className="event-form" onSubmit={(e) => void save(e)}>
        {readOnly && (
          <p className="dialog-text">
            This event is in {calendar?.name ?? "a calendar"}, which comes from the web, so it can't be changed here. Duplicate it into one of your calendars to change it.
          </p>
        )}
        <fieldset className="event-fieldset" disabled={readOnly}>
        <input className="text-input event-title" aria-label="Title" placeholder="Add title" value={d.title} autoFocus maxLength={500} onChange={(e) => set({ title: e.target.value })} />
        <div className="event-times">
          <label className="event-when">
            <span>Starts</span>
            <input className="text-input" type="date" aria-label="Start date" value={date(d.start)} required
              onChange={(e) => e.target.value && moveStart(d.allDay ? e.target.value : `${e.target.value}T${time(d.start)}`)} />
            {!d.allDay && (
              <input className="text-input" type="time" aria-label="Start time" step={300} value={time(d.start)} required
                onChange={(e) => e.target.value && moveStart(`${date(d.start)}T${e.target.value}`)} />
            )}
          </label>
          <label className="event-when">
            <span>Ends</span>
            <input className="text-input" type="date" aria-label="End date" value={lastDay} required
              onChange={(e) => e.target.value && set({ end: d.allDay ? addDays(e.target.value, 1) : `${e.target.value}T${time(d.end)}` })} />
            {!d.allDay && (
              <input className="text-input" type="time" aria-label="End time" step={300} value={time(d.end)} required
                onChange={(e) => e.target.value && set({ end: `${date(d.end)}T${e.target.value}` })} />
            )}
          </label>
          <div className="event-check">
            <label><input type="checkbox" checked={d.allDay} onChange={(e) => setAllDay(e.target.checked)} /> All day</label>
            {!d.allDay && !d.zonesOpen && (
              <button type="button" className="btn btn-text event-zone-btn" onClick={() => set({ zonesOpen: true })}>
                <Globe size={16} /> {startZone.replace(/_/g, " ")} ({zoneOffset(startZone, wallToMs(d.start, startZone))})
              </button>
            )}
          </div>
          {!d.allDay && d.zonesOpen && (
            <>
              <ZoneSelect label="Start time zone" shown={d.endZone !== null ? "Start zone" : "Time zone"} value={startZone} at={wallToMs(d.start, startZone)}
                onChange={(z) => set({ zone: z })} />
              {d.endZone !== null && (
                <ZoneSelect label="End time zone" shown="End zone" value={endZone} at={wallToMs(d.end, endZone)} onChange={(z) => set({ endZone: z })} />
              )}
              <div className="event-check">
                <label>
                  <input type="checkbox" checked={d.endZone !== null} onChange={(e) => set({ endZone: e.target.checked ? startZone : null })} />
                  A different time zone for the end (a flight, say)
                </label>
              </div>
            </>
          )}
          {backwards && <div className="form-error event-indent" role="alert">The event ends before it starts.</div>}
        </div>
        <RepeatField draft={d} customOpen={customOpen} setCustomOpen={setCustomOpen} onChange={(repeat) => set({ repeat })} />
        <label className="event-field">
          <span>Calendar</span>
          <span className="color-select">
            <span className="swatch" style={{ background: calendar?.color }} aria-hidden />
            <select className="text-input" value={calendarId ?? ""} onChange={(e) => set({ calendarId: Number(e.target.value) })}>
              {list.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </span>
        </label>
        {hosting ? (
          <div className="event-guests">
            <RecipientField label="Guests" placeholder="Add guests" account={acct.index} value={d.guests ?? []} onChange={(guests) => set({ guests })} />
            {loaded && loaded.attendees.length > 0 && <div className="event-indent"><Guests inv={loaded} me={mine} /></div>}
          </div>
        ) : (
          loaded && loaded.attendees.length > 0 && (
            <div className="event-field event-top">
              <span>Guests</span>
              <Guests inv={loaded} me={mine} />
            </div>
          )
        )}
        <label className="event-field">
          <span>Location</span>
          <input className="text-input" aria-label="Location" placeholder="Add location" value={d.location} maxLength={1000} onChange={(e) => set({ location: e.target.value })} />
        </label>
        <label className="event-field">
          <span>Video call</span>
          <input className="text-input" type="url" aria-label="Video call link" placeholder="Add a link" value={d.video ?? ""} maxLength={2000}
            onChange={(e) => set({ video: e.target.value })} />
        </label>
        <label className="event-field event-top">
          <span>Description</span>
          <textarea className="text-input" aria-label="Description" placeholder="Add description" rows={4} value={d.description} maxLength={20000}
            onChange={(e) => set({ description: e.target.value })} />
        </label>
        <div className="event-field event-top">
          <span id="event-reminders">Notifications</span>
          <RemindersField value={d.reminders ?? []} onChange={(reminders) => set({ reminders })} allDay={d.allDay}
            email={!!acct.accounts[acct.index]?.emailReminders} />
        </div>
        <label className="event-field">
          <span>Show as</span>
          <select className="text-input" value={d.busy ? "busy" : "free"} onChange={(e) => set({ busy: e.target.value === "busy" })}>
            <option value="busy">Busy</option>
            <option value="free">Free</option>
          </select>
        </label>
        <div className="event-field">
          <span id="event-colour">Colour</span>
          <div className="color-grid" role="radiogroup" aria-labelledby="event-colour">
            <button type="button" role="radio" aria-checked={d.color === null} className={`color-dot ${d.color === null ? "on" : ""}`} style={{ background: calendar?.color }}
              aria-label="The calendar's colour" title="The calendar's colour" onClick={() => set({ color: null })} />
            {COLORS.map((c) => (
              <button key={c.name} type="button" role="radio" aria-checked={d.color === c.name} className={`color-dot ${d.color === c.name ? "on" : ""}`}
                style={{ background: c.hex }} aria-label={c.label} title={c.label} onClick={() => set({ color: c.name })} />
            ))}
          </div>
        </div>
        </fieldset>
        {error && <div className="form-error" role="alert">{error}</div>}
        {readOnly ? (
          <div className="buttons">
            <button type="button" className="btn btn-text" onClick={close}>Close</button>
            <button type="button" className="btn btn-primary" onClick={duplicate}><Copy size={16} /> Duplicate</button>
          </div>
        ) : (
          <div className="buttons">
            {id !== undefined && loaded && (
              <button type="button" className="btn btn-danger" style={{ marginRight: "auto" }}
                onClick={() => { close(); void deleteEvent(acct.index, loaded, refresh); }}>
                <Trash2 size={16} /> Delete
              </button>
            )}
            <button type="button" className="btn btn-text" onClick={close}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy || backwards || calendarId === null}>{busy ? "Saving…" : "Save"}</button>
          </div>
        )}
      </form>
    </Modal>
  );
}

/** An event as the editor holds it: in its own zones when it has them, else the reader's. */
function fromLoaded(e: NonNullable<Awaited<ReturnType<typeof api.event>>["event"]>, zone: string): Draft {
  const own = e.eventZone ?? zone;
  const ownEnd = e.eventEndZone ?? own;
  const zoned = !e.allDay && (e.eventZone !== null || e.eventEndZone !== null);
  return {
    ...e,
    guests: e.attendees.map((p) => ({ address: p.address, name: p.name || undefined })),
    start: zoned ? instantToWall(wallToMs(e.start, zone), own) : e.start,
    end: zoned ? instantToWall(wallToMs(e.end, zone), ownEnd) : e.end,
    zone: e.allDay ? null : own,
    endZone: zoned && ownEnd !== own ? ownEnd : null,
    zonesOpen: zoned,
  };
}

function ZoneSelect({ label, shown, value, at, onChange }: { label: string; shown: string; value: string; at: number; onChange: (zone: string) => void }) {
  const zones = ZONES.includes(value) ? ZONES : [value, ...ZONES];
  return (
    <label className="event-field">
      <span>{shown}</span>
      <select className="text-input" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")} ({zoneOffset(z, at)})</option>)}
      </select>
    </label>
  );
}

const ORDINAL = ["", "first", "second", "third", "fourth"];

/** How the event repeats: Google Calendar's choices for its start date, or a rule of your own. */
function RepeatField({ draft, customOpen, setCustomOpen, onChange }: { draft: Draft; customOpen: boolean; setCustomOpen: (open: boolean) => void; onChange: (rule: RepeatRule | null) => void }) {
  const presets = repeatPresets(draft.start);
  const rule = draft.repeat;
  const match = presets.findIndex((p) => sameRule(p.rule, rule));
  const showCustom = customOpen || (match < 0 && !!rule && !rule.custom);
  const value = showCustom ? "custom" : match >= 0 ? String(match) : "kept";
  return (
    <>
      <label className="event-field">
        <span>Repeats</span>
        <select className="text-input" aria-label="Repeats" value={value}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "custom") {
              setCustomOpen(true);
              if (!rule || rule.custom) onChange({ freq: "weekly", interval: 1, days: [weekdayOf(draft.start)] });
            } else if (v !== "kept") {
              setCustomOpen(false);
              onChange(presets[Number(v)].rule);
            }
          }}>
          {presets.map((p, i) => <option key={i} value={i}>{p.label}</option>)}
          {value === "kept" && rule && <option value="kept">{repeatText(rule, draft.start)}</option>}
          <option value="custom">{showCustom && rule ? `Custom: ${repeatText(rule, draft.start)}` : "Custom…"}</option>
        </select>
      </label>
      {showCustom && rule && <CustomRepeat start={draft.start} rule={rule} onChange={onChange} />}
    </>
  );
}

/** A rule of your own: every so many days, weeks, months or years; on which days; until when. */
function CustomRepeat({ start, rule, onChange }: { start: string; rule: RepeatRule; onChange: (rule: RepeatRule) => void }) {
  const set = (patch: Partial<RepeatRule>) => onChange({ ...rule, ...patch });
  const { week, last } = nthOf(start);
  const day = weekdayOf(start);
  const ends = rule.count ? "count" : rule.until ? "until" : "never";
  const days = rule.days?.length ? rule.days : [day];
  return (
    <div className="custom-repeat">
      <div className="custom-row">
        <span>Every</span>
        <input className="text-input" type="number" min={1} max={999} aria-label="Repeat every" value={rule.interval}
          onChange={(e) => set({ interval: Math.max(1, Math.min(999, Number(e.target.value) || 1)) })} />
        <select className="text-input" aria-label="Repeat unit" value={rule.freq}
          onChange={(e) => onChange({ freq: e.target.value as RepeatRule["freq"], interval: rule.interval, until: rule.until, count: rule.count })}>
          {(["daily", "weekly", "monthly", "yearly"] as const).map((f) => (
            <option key={f} value={f}>{{ daily: "day", weekly: "week", monthly: "month", yearly: "year" }[f]}{rule.interval > 1 ? "s" : ""}</option>
          ))}
        </select>
      </div>
      {rule.freq === "weekly" && (
        <div className="custom-row weekday-row" role="group" aria-label="On these days">
          {WEEKDAYS.map((w) => (
            <button key={w} type="button" className={`weekday ${days.includes(w) ? "on" : ""}`} aria-pressed={days.includes(w)} aria-label={dayName(w)}
              onClick={() => {
                const next = days.includes(w) ? days.filter((x) => x !== w) : [...days, w];
                set({ days: next.length ? WEEKDAYS.filter((x) => next.includes(x)) : [day] });
              }}>
              {dayName(w, "short").slice(0, 1)}
            </button>
          ))}
        </div>
      )}
      {rule.freq === "monthly" && (
        <select className="text-input" aria-label="On which day of the month" value={rule.nth ? String(rule.nth.week) : "date"}
          onChange={(e) => set({ nth: e.target.value === "date" ? undefined : { week: Number(e.target.value), day } })}>
          <option value="date">On day {Number(start.slice(8, 10))}</option>
          {week <= 4 && <option value={week}>On the {ORDINAL[week]} {dayName(day)}</option>}
          {last && <option value={-1}>On the last {dayName(day)}</option>}
        </select>
      )}
      <div className="custom-ends" role="radiogroup" aria-label="Ends">
        <label><input type="radio" name="ends" checked={ends === "never"} onChange={() => set({ until: undefined, count: undefined })} /> Never ends</label>
        <label>
          <input type="radio" name="ends" checked={ends === "until"} onChange={() => set({ count: undefined, until: addDays(start.slice(0, 10), 90) })} /> Until
          <input className="text-input" type="date" aria-label="Repeats until" value={rule.until ?? ""} disabled={ends !== "until"} min={start.slice(0, 10)}
            onChange={(e) => e.target.value && set({ until: e.target.value, count: undefined })} />
        </label>
        <label>
          <input type="radio" name="ends" checked={ends === "count"} onChange={() => set({ until: undefined, count: 10 })} /> After
          <input className="text-input" type="number" min={1} max={9999} aria-label="Number of times" value={rule.count ?? ""} disabled={ends !== "count"}
            onChange={(e) => set({ count: Math.max(1, Math.min(9999, Number(e.target.value) || 1)), until: undefined })} /> times
        </label>
      </div>
    </div>
  );
}

/** Which occurrences of a repeating event a change or deletion is for. */
export function ScopeDialog() {
  const req = ui.use((s) => s.scopeDialog);
  const [scope, setScope] = useState<Scope>(req?.ruleChanged ? "following" : "this");
  if (!req) return null;
  const done = (s: Scope | null) => {
    ui.set((x) => ({ ...x, scopeDialog: null }));
    req.resolve(s);
  };
  const options: [Scope, string][] = [
    ...(req.ruleChanged ? [] : [["this", "This event"] as [Scope, string]]),
    ["following", "This and following events"],
    ["all", "All events"],
  ];
  return (
    <Modal open onClose={() => done(null)} title={req.action === "delete" ? "Delete repeating event" : "Change repeating event"}>
      <div className="scope-options" role="radiogroup" aria-label="Which events">
        {options.map(([v, label]) => (
          <label key={v}><input type="radio" name="scope" checked={scope === v} onChange={() => setScope(v)} /> {label}</label>
        ))}
      </div>
      <div className="buttons">
        <button type="button" className="btn btn-text" onClick={() => done(null)}>Cancel</button>
        <button type="button" className="btn btn-primary" autoFocus onClick={() => done(scope)}>OK</button>
      </div>
    </Modal>
  );
}

/** "Email the guests?" before a change to an event you organise reaches them, or doesn't. */
export function SendDialog() {
  const req = ui.use((s) => s.sendDialog);
  if (!req) return null;
  const done = (send: boolean | null) => {
    ui.set((x) => ({ ...x, sendDialog: null }));
    req.resolve(send);
  };
  const [title, body] = {
    invite: ["Send invitations?", "Email the guests an invitation, which any calendar app can answer."],
    change: ["Email the guests?", "Let the guests know about the change. Anyone you've taken off is told it's cancelled for them."],
    delete: ["Tell the guests it's cancelled?", "Email the guests that the event is cancelled."],
  }[req.action];
  return (
    <Modal open onClose={() => done(null)} title={title}>
      <p className="dialog-text">{body}</p>
      <div className="buttons">
        <button type="button" className="btn btn-text" onClick={() => done(null)}>Back</button>
        <button type="button" className="btn btn-outline" onClick={() => done(false)}>Don't send</button>
        <button type="button" className="btn btn-primary" autoFocus onClick={() => done(true)}>Send</button>
      </div>
    </Modal>
  );
}

/** Names and colours a new calendar, or one already there; for one from the web, its address and how fetching it went. */
export function CalendarDialog({ calendar }: { calendar?: CalendarInfo }) {
  const acct = useAccount();
  const client = useQueryClient();
  const [name, setName] = useState(calendar?.name ?? "");
  const [color, setColor] = useState<string | undefined>(calendar?.color);
  const [busy, setBusy] = useState(false);
  const close = () => ui.set((s) => ({ ...s, calendarDialog: null }));
  // The list's copy, which a refresh or a new secret address brings up to date.
  const listed = useQuery({ ...calendarsQuery(acct.index), enabled: !!calendar });
  const current = listed.data?.calendars.find((c) => c.id === calendar?.id) ?? calendar;
  const feed = current?.feed ?? null;
  const secrets = useConfig().data?.calendarSecrets ?? false;
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (calendar) await api.updateCalendar(acct.index, calendar.id, { name, ...(color ? { color } : {}) });
      else await api.createCalendar(acct.index, { name, ...(color ? { color } : {}) });
      await client.invalidateQueries({ queryKey: ["calendars", acct.index] });
      close();
    } catch (err) {
      toast((err as Error).message, { error: true });
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={close} title={calendar ? "Calendar settings" : "New calendar"}>
      <form onSubmit={(e) => void save(e)}>
        <input className="text-input" aria-label="Calendar name" placeholder="Name" value={name} autoFocus maxLength={100} onChange={(e) => setName(e.target.value)} />
        {calendar && feed && <FeedStatus calendarId={calendar.id} feed={feed} />}
        <div className="color-grid" role="radiogroup" aria-label="Calendar colour">
          {COLORS.map((c) => (
            <button key={c.name} type="button" role="radio" aria-checked={color === c.name} className={`color-dot ${color === c.name ? "on" : ""}`}
              style={{ background: c.hex }} aria-label={colorLabel(c.name)} title={c.label} onClick={() => setColor(c.name)} />
          ))}
        </div>
        <div className="buttons">
          <button type="button" className="btn btn-text" onClick={close}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={!name.trim() || busy}>{calendar ? "Save" : "Create"}</button>
        </div>
      </form>
      {/* Changes here apply at once, apart from Save. */}
      {current && (secrets || current.secret) && <SecretAddress calendar={current} on={secrets} />}
    </Modal>
  );
}

/** A calendar from the web: where it comes from, when it last came, what went wrong, and Refresh now. */
function FeedStatus({ calendarId, feed }: { calendarId: number; feed: NonNullable<CalendarInfo["feed"]> }) {
  const acct = useAccount();
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    setBusy(true);
    try {
      await api.refreshCalendar(acct.index, calendarId);
      toast("Calendar fetched again.");
    } catch (err) {
      toast((err as Error).message, { error: true });
    } finally {
      await client.invalidateQueries({ queryKey: ["calendars", acct.index] });
      void client.invalidateQueries({ queryKey: ["events", acct.index] });
      setBusy(false);
    }
  };
  return (
    <div className="feed-status">
      <div className="feed-url" title={feed.url}>{feed.url}</div>
      <div className="muted">
        {feed.fetchedAt ? <>Updated {relative(feed.fetchedAt)}. </> : null}
        Fetched again every 6 hours.
      </div>
      {feed.error && (
        <div className="form-error" role="status">
          {feed.checkedAt ? `Last tried ${relative(feed.checkedAt)}: ` : ""}{feed.error}
        </div>
      )}
      <button type="button" className="btn btn-outline" disabled={busy} onClick={() => void refresh()}>
        <RefreshCw size={16} className={busy ? "spin" : ""} /> Refresh now
      </button>
    </div>
  );
}

/**
 * A calendar's secret address, for another app to show it read-only: made here, shown this
 * once (only its hash is kept), whole or busy-only, made again to stop the old one, or off.
 */
function SecretAddress({ calendar, on }: { calendar: CalendarInfo; on: boolean }) {
  const acct = useAccount();
  const client = useQueryClient();
  const [mode, setMode] = useState<SecretMode>(calendar.secret?.mode ?? "all");
  const [made, setMade] = useState<string | null>(null);
  const [renewing, setRenewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const secret = calendar.secret;
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
    } catch (err) {
      toast((err as Error).message, { error: true });
    } finally {
      await client.invalidateQueries({ queryKey: ["calendars", acct.index] });
      setBusy(false);
    }
  };
  const make = () => run(async () => {
    const r = await api.makeSecret(acct.index, calendar.id, mode);
    setMade(api.secretUrl(r.token));
    setRenewing(false);
  });
  const copy = (url: string) =>
    navigator.clipboard.writeText(url).then(() => toast("Address copied."), () => toast("Couldn't copy: select the address and copy it.", { error: true }));
  return (
    <section className="secret-address" aria-labelledby={`secret-${calendar.id}`}>
      <h3 id={`secret-${calendar.id}`}><KeyRound size={16} aria-hidden /> Secret address</h3>
      {!on ? (
        <p className="muted">Secret addresses are turned off on this server, so this calendar's doesn't work until they're on again.</p>
      ) : made ? (
        <>
          <div className="secret-url">
            <input className="text-input" readOnly aria-label="Secret address" value={made} onFocus={(e) => e.currentTarget.select()} />
            <button type="button" className="btn btn-outline" onClick={() => void copy(made)}><Copy size={16} /> Copy</button>
          </div>
          <p className="dialog-text">
            <strong>Copy it now.</strong> Viauna keeps only a fingerprint of it, so it can't show it again. Paste it into another app's
            "add calendar from URL". Anyone who has it can see {mode === "busy" ? "when you're busy" : "this calendar"}, without signing in.
          </p>
        </>
      ) : null}
      {on && (
        <label className="event-field">
          <span>Shows</span>
          <select className="text-input" value={mode} disabled={busy}
            onChange={(e) => {
              const next = e.target.value as SecretMode;
              setMode(next);
              if (secret) void run(() => api.setSecretMode(acct.index, calendar.id, next));
            }}>
            <option value="all">The whole calendar</option>
            <option value="busy">Only when you're busy</option>
          </select>
        </label>
      )}
      {on && !secret && !made && (
        <>
          <p className="muted">Another app (your phone's calendar, Outlook, another calendar) can show this calendar from a secret address, read-only, and keep it up to date.</p>
          <button type="button" className="btn btn-outline" disabled={busy} onClick={() => void make()}>Make a secret address</button>
        </>
      )}
      {secret && (
        <>
          <p className="muted" title={longDate(secret.createdAt)}>
            Made {relative(secret.createdAt)}. {secret.fetchedAt ? `Last fetched ${relative(secret.fetchedAt)}.` : "Not fetched yet."}
          </p>
          {renewing ? (
            <div className="secret-confirm" role="group" aria-label="Make a new address">
              <span>The address in use stops working at once. Apps using it stop updating until they're given the new one.</span>
              <button type="button" className="btn btn-text" onClick={() => setRenewing(false)}>Keep it</button>
              <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void make()}>Make a new one</button>
            </div>
          ) : (
            <div className="buttons secret-buttons">
              {on && <button type="button" className="btn btn-outline" disabled={busy} onClick={() => setRenewing(true)}><RefreshCw size={16} /> Make a new address</button>}
              <button type="button" className="btn btn-text" disabled={busy}
                onClick={() => void run(async () => { await api.dropSecret(acct.index, calendar.id); setMade(null); })}>Turn off</button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** Adds a calendar from the web by its address: holidays, fixtures, another service's calendar. */
export function SubscribeDialog() {
  const acct = useAccount();
  const client = useQueryClient();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const close = () => ui.set((s) => ({ ...s, subscribeDialog: false }));
  const go = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { calendar } = await api.subscribeCalendar(acct.index, url);
      void client.invalidateQueries({ queryKey: ["calendars", acct.index] });
      void client.invalidateQueries({ queryKey: ["events", acct.index] });
      toast(`Added "${calendar.name}".`);
      close();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={close} title="Add a calendar from the web">
      <form className="event-form" onSubmit={(e) => void go(e)}>
        <p className="dialog-text">
          The calendar's address, which ends in .ics or starts with webcal://: public holidays, a team's fixtures, or another
          calendar app's secret address. This server fetches it now and every 6 hours. It shows here as it is there, and
          can't be changed here.
        </p>
        <input className="text-input" type="url" aria-label="Calendar address" placeholder="https://… or webcal://…" value={url} autoFocus
          maxLength={2000} onChange={(e) => setUrl(e.target.value)} />
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="buttons">
          <button type="button" className="btn btn-text" onClick={close}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={!url.trim() || busy}>{busy ? "Fetching…" : "Add calendar"}</button>
        </div>
      </form>
    </Modal>
  );
}

/** Adds the events in a calendar file (.ics) to a calendar, or to a new one. */
export function ImportDialog() {
  const acct = useAccount();
  const client = useQueryClient();
  const calendars = useQuery(calendarsQuery(acct.index));
  const list = (calendars.data?.calendars ?? []).filter((c) => !c.readOnly);
  const [file, setFile] = useState<File | null>(null);
  const [target, setTarget] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const chosen = target || String(list.find((c) => c.primary)?.id ?? "new");
  const close = () => ui.set((s) => ({ ...s, importDialog: false }));
  const go = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const r = await api.importCalendar(acct.index, chosen === "new" ? "new" : Number(chosen), file);
      const parts = [
        r.added && `${r.added} added`,
        r.updated && `${r.updated} updated`,
        r.unchanged && `${r.unchanged} already here`,
        r.skipped && `${r.skipped} skipped (not events Viauna can read)`,
      ].filter(Boolean);
      toast(`Imported: ${parts.join(", ") || "nothing new"}.`);
      void client.invalidateQueries({ queryKey: ["calendars", acct.index] });
      void client.invalidateQueries({ queryKey: ["events", acct.index] });
      close();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={close} title="Import events">
      <form className="event-form" onSubmit={(e) => void go(e)}>
        <p className="dialog-text">
          A calendar file (.ics) exported from another calendar app. Events already here are updated, not added twice.
        </p>
        <input ref={input} type="file" accept=".ics,text/calendar" hidden onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <div className="event-field">
          <span>File</span>
          <div className="import-file">
            <button type="button" className="btn btn-outline" onClick={() => input.current?.click()}>Choose a file</button>
            <span className="muted">{file ? file.name : "No file chosen"}</span>
          </div>
        </div>
        <label className="event-field">
          <span>Into</span>
          <select className="text-input" aria-label="Into which calendar" value={chosen} onChange={(e) => setTarget(e.target.value)}>
            {list.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            <option value="new">A new calendar, named as the file names it</option>
          </select>
        </label>
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="buttons">
          <button type="button" className="btn btn-text" onClick={close}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={!file || busy}>{busy ? "Importing…" : "Import"}</button>
        </div>
      </form>
    </Modal>
  );
}
