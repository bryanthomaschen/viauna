// The event editor, opened from the calendar, from an event's card, or from an email
// ("Create event"); and the dialog that names and colours a calendar. Times are edited as
// dates and wall-clock times in the calendar's time zone. Kept apart from Calendar.tsx so
// that opening it from a message doesn't load the calendar grid.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { ui, useAccount } from "../lib/account";
import { api } from "../lib/api";
import { COLORS, addDays, addMinutes, colorLabel, nextHalfHour, useCalendarZone, wallToMs, zoneOffset } from "../lib/calendar";
import { toast } from "../lib/store";
import type { CalendarInfo, EventInput } from "../lib/types";
import { Modal } from "./common";

type Draft = EventInput & { calendarId: number | null };

const blank = (start: string, end: string): Draft => ({
  title: "", allDay: false, start, end, zone: null, location: "", description: "", busy: true, color: null, video: null, calendarId: null,
});

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

export function deleteEvent(index: number, id: number, refresh: () => void) {
  void api
    .deleteEvent(index, id)
    .then(({ undo }) => {
      refresh();
      toast("Event deleted.", { action: undoable(index, refresh)(undo) });
    })
    .catch((err: Error) => toast(err.message, { error: true }));
}

/** Adds an event (from `initial`) or edits one (`id`). */
export function EventDialog({ id, initial }: { id?: number; initial?: Partial<EventInput> & { calendarId?: number } }) {
  const acct = useAccount();
  const client = useQueryClient();
  const zone = useCalendarZone();
  const minutes = acct.settings?.eventMinutes ?? 60;
  const close = () => ui.set((s) => ({ ...s, eventDialog: null }));
  const calendars = useQuery({ queryKey: ["calendars", acct.index], queryFn: () => api.calendars(acct.index) });
  const existing = useQuery({ queryKey: ["event", acct.index, id, zone], queryFn: () => api.event(acct.index, id!, zone), enabled: id !== undefined, staleTime: 0 });
  const [draft, setDraft] = useState<Draft | null>(() => {
    if (id !== undefined) return null;
    const start = initial?.start ?? nextHalfHour(zone);
    const end = initial?.end ?? (initial?.allDay ? addDays(start, 1) : addMinutes(start, minutes, zone));
    return { ...blank(start, end), ...initial, start, end, calendarId: initial?.calendarId ?? null };
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const list = calendars.data?.calendars ?? [];
  const loaded = existing.data?.event;
  const d: Draft | null = draft ?? (loaded ? { ...loaded } : null);
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

  const date = (v: string) => v.slice(0, 10);
  const time = (v: string) => v.slice(11, 16);
  // An all-day event's end is the day after its last; the form shows the last day.
  const lastDay = d.allDay ? addDays(d.end, -1) : date(d.end);
  const length = d.allDay ? 0 : wallToMs(d.end, zone) - wallToMs(d.start, zone);
  const backwards = d.allDay ? d.end <= d.start : length < 0;

  /** A new start keeps the event's length, as in Google Calendar. */
  const moveStart = (start: string) => {
    if (d.allDay) {
      const days = Math.round((Date.parse(d.end) - Date.parse(d.start)) / 86_400_000);
      set({ start, end: addDays(start, days) });
    } else {
      set({ start, end: addMinutes(start, Math.max(0, length) / 60_000, zone) });
    }
  };
  const setAllDay = (allDay: boolean) => {
    if (allDay) set({ allDay, start: date(d.start), end: addDays(date(d.end) < date(d.start) ? date(d.start) : date(d.end), 1) });
    else {
      const start = `${date(d.start)}T09:00`;
      set({ allDay, start, end: addMinutes(start, minutes, zone) });
    }
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (backwards || calendarId === null) return;
    setBusy(true);
    setError("");
    const input: EventInput = {
      title: d.title, allDay: d.allDay, start: d.start, end: d.end, zone: d.allDay ? null : zone,
      location: d.location, description: d.description, busy: d.busy, color: d.color, video: d.video?.trim() || null,
    };
    try {
      if (id === undefined) {
        await api.createEvent(acct.index, calendarId, input, zone);
        toast("Event saved.");
      } else {
        const { undo } = await api.updateEvent(acct.index, id, { ...input, calendarId }, zone);
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
          <label className="event-check">
            <input type="checkbox" checked={d.allDay} onChange={(e) => setAllDay(e.target.checked)} /> All day
          </label>
          {!d.allDay && (
            <div className="event-zone">
              Times in {zone.replace(/_/g, " ")} ({zoneOffset(zone, wallToMs(d.start, zone))})
              {loaded?.eventZone && <>; made in {loaded.eventZone.replace(/_/g, " ")} time, where it stays</>}
            </div>
          )}
          {backwards && <div className="form-error" role="alert">The event ends before it starts.</div>}
        </div>
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
          {id !== undefined && (
            <button type="button" className="btn btn-danger" style={{ marginRight: "auto" }} onClick={() => { close(); deleteEvent(acct.index, id, refresh); }}>
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
