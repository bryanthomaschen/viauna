// The event editor, opened from the calendar, from an event's card, or from an email
// ("Create event"); the question of which occurrences a change to a repeating event is
// for; and the dialog that names and colours a calendar. Times are edited as dates and
// wall-clock times: in the calendar's time zone, or in the event's own zones when it has
// them or they're set here. Kept apart from Calendar.tsx so that opening it from a
// message doesn't load the calendar grid.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe, Trash2 } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import { ui, useAccount } from "../lib/account";
import { api } from "../lib/api";
import {
  COLORS,
  WEEKDAYS,
  addDays,
  addMinutes,
  askScope,
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
import { toast } from "../lib/store";
import type { CalendarInfo, EventInput, RepeatRule, Scope } from "../lib/types";
import { Modal } from "./common";

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
export async function deleteEvent(index: number, e: { id: number; occurrence: string | null; recurring: boolean }, refresh: () => void) {
  let scope: Scope | undefined;
  if (e.recurring) {
    const asked = await askScope("delete");
    if (!asked) return;
    scope = asked;
  }
  try {
    const { undo } = await api.deleteEvent(index, e.id, e.recurring ? e.occurrence : null, scope);
    refresh();
    toast("Event deleted.", { action: undoable(index, refresh)(undo) });
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
  const calendars = useQuery({ queryKey: ["calendars", acct.index], queryFn: () => api.calendars(acct.index) });
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
    return { ...blank(start, end, zone), ...initial, start, end, zone: initial?.allDay ? null : zone, calendarId: initial?.calendarId ?? null };
  });
  const [customOpen, setCustomOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Only calendars whose events are kept here can take one.
  const list = (calendars.data?.calendars ?? []).filter((c) => !c.readOnly);
  const loaded = existing.data?.event;
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
    if (allDay) set({ allDay, start: date(d.start), end: addDays(date(d.end) < date(d.start) ? date(d.start) : date(d.end), 1) });
    else {
      const start = `${date(d.start)}T09:00`;
      set({ allDay, zone: startZone, start, end: addMinutes(start, minutes, startZone) });
    }
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (backwards || calendarId === null) return;
    const input: EventInput = {
      title: d.title, allDay: d.allDay, start: d.start, end: d.end, zone: d.allDay ? null : startZone, endZone: d.allDay || endZone === startZone ? null : endZone,
      location: d.location, description: d.description, busy: d.busy, color: d.color, video: d.video?.trim() || null, repeat: d.repeat,
    };
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
        await api.createEvent(acct.index, calendarId, input, zone);
        toast("Event saved.");
      } else {
        // The editor's times are in the zones it shows: say so, so they're kept.
        const setZones = d.zonesOpen || startZone !== zone;
        const { undo } = await api.updateEvent(acct.index, id, { ...input, calendarId, occurrence: loaded?.occurrence ?? null, scope, setZones }, zone);
        toast("Event saved.", { action: undoable(acct.index, refresh)(undo) });
      }
      refresh();
      close();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={close} title={id === undefined ? "New event" : "Edit event"}>
      <form className="event-form" onSubmit={(e) => void save(e)}>
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
            <div className="event-zones">
              <ZoneSelect label="Start time zone" value={startZone} at={wallToMs(d.start, startZone)}
                onChange={(z) => set({ zone: z })} />
              {d.endZone !== null && (
                <ZoneSelect label="End time zone" value={endZone} at={wallToMs(d.end, endZone)} onChange={(z) => set({ endZone: z })} />
              )}
              <label className="event-check-inline">
                <input type="checkbox" checked={d.endZone !== null} onChange={(e) => set({ endZone: e.target.checked ? startZone : null })} />
                A different time zone for the end (a flight, say)
              </label>
            </div>
          )}
          {backwards && <div className="form-error" role="alert">The event ends before it starts.</div>}
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
        <input className="text-input" aria-label="Location" placeholder="Add location" value={d.location} maxLength={1000} onChange={(e) => set({ location: e.target.value })} />
        <input className="text-input" type="url" aria-label="Video call link" placeholder="Add a video call link" value={d.video ?? ""} maxLength={2000}
          onChange={(e) => set({ video: e.target.value })} />
        <textarea className="text-input" aria-label="Description" placeholder="Add description" rows={4} value={d.description} maxLength={20000}
          onChange={(e) => set({ description: e.target.value })} />
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
        {error && <div className="form-error" role="alert">{error}</div>}
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
    start: zoned ? instantToWall(wallToMs(e.start, zone), own) : e.start,
    end: zoned ? instantToWall(wallToMs(e.end, zone), ownEnd) : e.end,
    zone: e.allDay ? null : own,
    endZone: zoned && ownEnd !== own ? ownEnd : null,
    zonesOpen: zoned,
  };
}

function ZoneSelect({ label, value, at, onChange }: { label: string; value: string; at: number; onChange: (zone: string) => void }) {
  const zones = ZONES.includes(value) ? ZONES : [value, ...ZONES];
  return (
    <label className="event-field">
      <span>{label.replace(" time zone", "")}</span>
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

/** Names and colours a new calendar, or one already there. */
export function CalendarDialog({ calendar }: { calendar?: CalendarInfo }) {
  const acct = useAccount();
  const client = useQueryClient();
  const [name, setName] = useState(calendar?.name ?? "");
  const [color, setColor] = useState<string | undefined>(calendar?.color);
  const [busy, setBusy] = useState(false);
  const close = () => ui.set((s) => ({ ...s, calendarDialog: null }));
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
    </Modal>
  );
}

/** Adds the events in a calendar file (.ics) to a calendar, or to a new one. */
export function ImportDialog() {
  const acct = useAccount();
  const client = useQueryClient();
  const calendars = useQuery({ queryKey: ["calendars", acct.index], queryFn: () => api.calendars(acct.index) });
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
        <div className="import-file">
          <button type="button" className="btn btn-outline" onClick={() => input.current?.click()}>Choose a file</button>
          <span className="muted">{file ? file.name : "No file chosen"}</span>
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
