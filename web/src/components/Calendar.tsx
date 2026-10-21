// The calendar: a day, week, month, schedule or four-day view of the mailbox's calendars
// (FullCalendar), the sidebar with a month to jump around in and the calendars to show
// or hide, the card an event opens, and events found by a search. The address holds the
// view and a date in it (/u/0/calendar/week/2026-10-21), so Back and a reload keep the
// place. Times are shown in the calendar's time zone, which FullCalendar is given.
import "@fullcalendar/react/skeleton.css";
import "@fullcalendar/react/themes/monarch/theme.css";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Popover from "@radix-ui/react-popover";
import FullCalendar, {
  type CalendarRef,
  type DateClickInfo,
  type DateSelectInfo,
  type DatesSetInfo,
  type EventClickInfo,
  type EventDropInfo,
  type EventInput as FcEvent,
  type EventResizeDoneInfo,
} from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/react/daygrid";
import interactionPlugin from "@fullcalendar/react/interaction";
import listPlugin from "@fullcalendar/react/list";
import enAu from "@fullcalendar/react/locales/en-au";
import enGb from "@fullcalendar/react/locales/en-gb";
import enNz from "@fullcalendar/react/locales/en-nz";
import monarchPlugin from "@fullcalendar/react/themes/monarch";
import timeGridPlugin from "@fullcalendar/react/timegrid";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Temporal } from "temporal-polyfill";
import {
  ArrowLeft, CalendarDays, ChevronDown, ChevronLeft, ChevronRight, Copy, EllipsisVertical, Eye, MapPin, Pencil, Plus, Settings, Text, Trash2, Video, X,
} from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ui, useAccount } from "../lib/account";
import { api } from "../lib/api";
import {
  VIEW_KEYS,
  VIEW_LABELS,
  addDays,
  addMinutes,
  firstDay,
  formatWhen,
  instantToWall,
  textOnColor,
  today,
  useCalendarZone,
} from "../lib/calendar";
import { CALENDAR_VIEWS, type CalendarView, type Route, calendarPath, navigate } from "../lib/router";
import { prefs, toast } from "../lib/store";
import type { CalendarInfo, EventSummary } from "../lib/types";
import { IconButton } from "./common";
import { deleteEvent, undoable } from "./EventDialog";
import { useViewHandlers } from "./shortcuts";

/** FullCalendar's name for each view; the four-day and schedule views are its custom ones. */
const FC_VIEW: Record<CalendarView, string> = {
  day: "timeGridDay",
  week: "timeGridWeek",
  month: "dayGridMonth",
  schedule: "listSchedule",
  "4days": "timeGridFourDays",
};
const VIEW_OF = Object.fromEntries(Object.entries(FC_VIEW).map(([k, v]) => [v, k])) as Record<string, CalendarView>;

const narrow = () => matchMedia("(max-width: 720px)").matches;

// Viauna's words are English, so the calendar's are too, in the browser's English if it has
// one (en-GB writes "21 October"); times follow the browser's 12- or 24-hour clock.
const LOCALES = [enGb, enAu, enNz];
const LOCALE = LOCALES.find((l) => l.code === navigator.language.toLowerCase())?.code ?? "en";
const HOUR12 = new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hour12 ?? true;

/** The view to show: the address's, else the last one picked, else week (schedule on a phone). */
function useView(route: Route): CalendarView {
  const picked = prefs.use((p) => p.calendarView);
  return route.calendar?.view ?? picked ?? (narrow() ? "schedule" : "week");
}

function useCalendars() {
  const acct = useAccount();
  return useQuery({ queryKey: ["calendars", acct.index], queryFn: () => api.calendars(acct.index), staleTime: 60_000 });
}

const openEvent = (id: number) => ui.set((s) => ({ ...s, eventDialog: { id } }));
const newEvent = (initial: NonNullable<ReturnType<typeof ui.get>["eventDialog"]>["initial"] = {}) => ui.set((s) => ({ ...s, eventDialog: { initial } }));

// ---------------------------------------------------------------- the sidebar

export function CalendarSidebar({ route, collapsed, open }: { route: Route; collapsed: boolean; open: boolean }) {
  const acct = useAccount();
  const client = useQueryClient();
  const zone = useCalendarZone();
  const view = useView(route);
  const calendars = useCalendars().data?.calendars ?? [];
  const selected = route.calendar?.date ?? today(zone);
  const toggle = async (c: CalendarInfo, visible: boolean) => {
    // Shown or hidden at once; the server's answer follows.
    client.setQueryData(["calendars", acct.index], { calendars: calendars.map((x) => (x.id === c.id ? { ...x, visible } : x)) });
    try {
      await api.updateCalendar(acct.index, c.id, { visible });
    } catch (err) {
      toast((err as Error).message, { error: true });
    }
    void client.invalidateQueries({ queryKey: ["calendars", acct.index] });
  };
  const only = async (c: CalendarInfo) => {
    await Promise.all(calendars.map((x) => (x.visible !== (x.id === c.id) ? api.updateCalendar(acct.index, x.id, { visible: x.id === c.id }) : null)));
    void client.invalidateQueries({ queryKey: ["calendars", acct.index] });
  };
  const remove = (c: CalendarInfo) =>
    ui.set((s) => ({
      ...s,
      confirm: {
        title: `Delete the calendar "${c.name}"?`,
        body: "It and every event in it will be deleted. This can't be undone.",
        action: "Delete",
        run: async () => {
          await api.deleteCalendar(acct.index, c.id);
          void client.invalidateQueries({ queryKey: ["calendars", acct.index] });
          void client.invalidateQueries({ queryKey: ["events", acct.index] });
        },
      },
    }));

  return (
    <nav className={`sidebar calendar-sidebar ${collapsed ? "collapsed" : ""} ${open ? "open" : ""}`} aria-label="Calendars">
      <button type="button" className="compose-btn" onClick={() => newEvent()} title="Create an event">
        <Plus size={22} />
        <span>Create</span>
      </button>
      {!collapsed && (
        <MiniMonth
          key={selected.slice(0, 7)}
          selected={selected}
          zone={zone}
          weekStart={firstDay(acct.settings?.weekStart)}
          onPick={(date) => {
            ui.set((s) => ({ ...s, sidebarOpen: false }));
            navigate(calendarPath(acct.index, view, date));
          }}
        />
      )}
      <div className="nav-section">
        <span>My calendars</span>
        <IconButton label="Create a calendar" size="sm" onClick={() => ui.set((s) => ({ ...s, calendarDialog: {} }))}>
          <Plus size={18} />
        </IconButton>
      </div>
      <ul className="nav calendar-list">
        {calendars.map((c) => (
          <li key={c.id} className="has-menu">
            <label className="nav-item" title={c.name}>
              <input type="checkbox" className="calendar-check" checked={c.visible} style={{ accentColor: c.color }}
                onChange={(e) => void toggle(c, e.target.checked)} />
              <span className="nav-label">{c.name}</span>
            </label>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button type="button" className="icon-btn xs nav-menu-btn" aria-label={`Options for ${c.name}`}>
                  <EllipsisVertical size={16} />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content className="menu" align="start" sideOffset={4}>
                  <DropdownMenu.Item className="menu-item" onSelect={() => void only(c)}><Eye size={18} /> Show only this one</DropdownMenu.Item>
                  <DropdownMenu.Item className="menu-item" onSelect={() => ui.set((s) => ({ ...s, calendarDialog: { calendar: c } }))}>
                    <Settings size={18} /> Name and colour
                  </DropdownMenu.Item>
                  {!c.primary && (
                    <DropdownMenu.Item className="menu-item" onSelect={() => remove(c)}><Trash2 size={18} /> Delete calendar</DropdownMenu.Item>
                  )}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** A month to jump to a day from, as in the corner of Google Calendar. */
function MiniMonth({ selected, zone, weekStart, onPick }: { selected: string; zone: string; weekStart: number; onPick: (date: string) => void }) {
  const [month, setMonth] = useState(() => Temporal.PlainDate.from(selected).with({ day: 1 }));
  const now = today(zone);
  // Six rows from the first day of the week on or before the 1st.
  const first = month.subtract({ days: (month.dayOfWeek % 7 - weekStart + 7) % 7 });
  const days = Array.from({ length: 42 }, (_, i) => first.add({ days: i }));
  const names = Array.from({ length: 7 }, (_, i) => days[i].toLocaleString(undefined, { weekday: "narrow" }));
  const title = month.toLocaleString(undefined, { month: "long", year: "numeric" });
  return (
    <div className="mini-month">
      <div className="mini-month-head">
        <span>{title}</span>
        <IconButton label="Previous month" size="xs" onClick={() => setMonth(month.subtract({ months: 1 }))}><ChevronLeft size={16} /></IconButton>
        <IconButton label="Next month" size="xs" onClick={() => setMonth(month.add({ months: 1 }))}><ChevronRight size={16} /></IconButton>
      </div>
      <div className="mini-month-grid" role="group" aria-label={title}>
        {names.map((n, i) => <span key={i} className="mini-dow" aria-hidden>{n}</span>)}
        {days.map((d) => {
          const iso = d.toString();
          return (
            <button key={iso} type="button" onClick={() => onPick(iso)}
              className={`mini-day ${d.month !== month.month ? "other" : ""} ${iso === now ? "today" : ""} ${iso === selected ? "selected" : ""}`}
              aria-label={d.toLocaleString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
              aria-current={iso === now ? "date" : undefined}>
              {d.day}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the main panel

export function CalendarMain({ route }: { route: Route }) {
  return route.calendar?.search !== null && route.calendar?.search !== undefined ? <CalendarSearch query={route.calendar.search} /> : <CalendarGrid route={route} />;
}

type Anchored = { rect: DOMRect };
type QuickState = Anchored & { allDay: boolean; start: string; end: string };
type CardState = Anchored & { event: EventSummary };

function CalendarGrid({ route }: { route: Route }) {
  const acct = useAccount();
  const client = useQueryClient();
  const zone = useCalendarZone();
  const view = useView(route);
  const date = route.calendar?.date ?? today(zone);
  const p = prefs.use();
  const ref = useRef<CalendarRef>(null);
  const [range, setRange] = useState<{ from: string; to: string; title: string } | null>(null);
  const [quick, setQuick] = useState<QuickState | null>(null);
  const [card, setCard] = useState<CardState | null>(null);
  const minutes = acct.settings?.eventMinutes ?? 60;
  /** Where the last click on the grid was, for the card its selection opens. */
  const clickedAt = useRef<DOMRect | null>(null);
  const calendars = useCalendars().data?.calendars ?? [];
  const events = useQuery({
    queryKey: ["events", acct.index, range?.from, range?.to, zone],
    queryFn: () => api.events(acct.index, range!.from, range!.to, zone),
    enabled: !!range,
    placeholderData: keepPreviousData,
  });
  const refresh = () => void client.invalidateQueries({ queryKey: ["events", acct.index] });
  const calApi = () => ref.current?.getApi();

  // FullCalendar follows the address: Back, the mini month and the shortcuts all change it.
  useEffect(() => {
    const c = calApi();
    if (!c) return;
    if (c.view.type !== FC_VIEW[view] || c.formatIso(c.getDate(), true).slice(0, 10) !== date) c.changeView(FC_VIEW[view], date);
  }, [view, date]);

  const go = (v: CalendarView, d: string) => {
    if (v !== view) prefs.set((x) => ({ ...x, calendarView: v }));
    navigate(calendarPath(acct.index, v, d));
  };
  const step = (dir: 1 | -1) => {
    const c = calApi();
    if (!c) return;
    if (dir > 0) c.next();
    else c.prev();
    navigate(calendarPath(acct.index, view, c.formatIso(c.getDate(), true).slice(0, 10)));
  };

  useViewHandlers({
    next: () => step(1),
    prev: () => step(-1),
    nextMessage: () => step(1),
    prevMessage: () => step(-1),
    calendarView: (v) => go(v, date),
    today: () => go(view, today(zone)),
    create: () => newEvent(),
    escape: () => {
      setQuick(null);
      setCard(null);
    },
    commands: () => ({
      target: "Calendar",
      items: [
        { label: "Today", icon: CalendarDays, key: "t", run: () => go(view, today(zone)) },
        ...CALENDAR_VIEWS.filter((v) => v !== view).map((v) => ({ label: `${VIEW_LABELS[v]} view`, icon: CalendarDays, key: VIEW_KEYS[v], run: () => go(v, date) })),
        { label: "Next", icon: ChevronRight, key: "j", run: () => step(1) },
        { label: "Previous", icon: ChevronLeft, key: "k", run: () => step(-1) },
      ],
    }),
  });

  const visible = useMemo(() => new Map(calendars.filter((c) => c.visible).map((c) => [c.id, c])), [calendars]);
  const fcEvents = useMemo<FcEvent[]>(
    () =>
      (events.data?.events ?? [])
        .filter((e) => visible.has(e.calendarId))
        .map((e) => {
          const color = e.color ?? visible.get(e.calendarId)!.color;
          return {
            id: String(e.id), title: e.title || "(No title)", start: e.start, end: e.end, allDay: e.allDay,
            color, contrastColor: textOnColor(color), className: e.busy ? "" : "event-free", extendedProps: { summary: e },
          };
        }),
    [events.data, visible],
  );

  const onDatesSet = (info: DatesSetInfo) => {
    setRange({ from: info.startStr.slice(0, 10), to: info.endStr.slice(0, 10), title: info.view.title });
  };

  // A drag selects the time it covers; a click selects an event of the usual length, as
  // in Google Calendar (selections need a few pixels of movement, so a click comes here).
  const onDateClick = (info: DateClickInfo) => {
    clickedAt.current = new DOMRect(info.jsEvent.clientX, info.jsEvent.clientY, 0, 0);
    if (info.allDay) calApi()?.select({ start: info.dateStr.slice(0, 10), allDay: true });
    else calApi()?.select({ start: info.date, end: new Date(info.date.getTime() + minutes * 60_000), allDay: false });
  };

  const onSelect = (info: DateSelectInfo) => {
    const start = info.allDay ? info.startStr.slice(0, 10) : instantToWall(info.start.getTime(), zone);
    const end = info.allDay ? info.endStr.slice(0, 10) : instantToWall(info.end.getTime(), zone);
    const at = info.jsEvent ? new DOMRect(info.jsEvent.clientX, info.jsEvent.clientY, 0, 0) : (clickedAt.current ?? new DOMRect(innerWidth / 2, innerHeight / 3, 0, 0));
    clickedAt.current = null;
    setCard(null);
    setQuick({ rect: at, allDay: info.allDay, start, end });
  };

  const onEventClick = (info: EventClickInfo) => {
    info.jsEvent.preventDefault();
    setQuick(null);
    setCard({ rect: info.el.getBoundingClientRect(), event: info.event.extendedProps.summary as EventSummary });
  };

  const onMoved = (info: EventDropInfo | EventResizeDoneInfo) => {
    const ev = info.event;
    const allDay = ev.allDay;
    let start: string;
    let end: string;
    if (allDay) {
      start = ev.startStr.slice(0, 10);
      end = ev.endStr ? ev.endStr.slice(0, 10) : addDays(start, 1);
    } else {
      start = instantToWall(ev.start!.getTime(), zone);
      end = ev.end ? instantToWall(ev.end.getTime(), zone) : addMinutes(start, minutes, zone);
    }
    api
      .updateEvent(acct.index, Number(ev.id), { allDay, start, end, zone: allDay ? null : zone }, zone)
      .then(({ undo }) => {
        refresh();
        toast("Event moved.", { action: undoable(acct.index, refresh)(undo) });
      })
      .catch((err: Error) => {
        info.revert();
        toast(err.message, { error: true });
      });
  };

  const close = () => {
    setQuick(null);
    calApi()?.unselect();
  };

  return (
    <>
      <div className="toolbar calendar-toolbar">
        <button type="button" className="btn btn-outline" onClick={() => go(view, today(zone))}>Today</button>
        <IconButton label={`Previous ${view === "month" ? "month" : view === "day" ? "day" : "period"}`} onClick={() => step(-1)}><ChevronLeft size={20} /></IconButton>
        <IconButton label={`Next ${view === "month" ? "month" : view === "day" ? "day" : "period"}`} onClick={() => step(1)}><ChevronRight size={20} /></IconButton>
        <h2 className="calendar-title" aria-live="polite">{range?.title ?? ""}</h2>
        <div className="grow" />
        {events.isFetching && <div className="spinner" aria-label="Loading events" />}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button type="button" className="btn btn-outline view-btn" aria-label={`View: ${VIEW_LABELS[view]}`}>
              {VIEW_LABELS[view]} <ChevronDown size={16} />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="menu" align="end" sideOffset={4}>
              {CALENDAR_VIEWS.map((v) => (
                <DropdownMenu.Item key={v} className="menu-item" onSelect={() => go(v, date)}>
                  <span style={{ flex: 1 }}>{VIEW_LABELS[v]}</span>
                  {p.shortcuts && <kbd>{VIEW_KEYS[v]}</kbd>}
                </DropdownMenu.Item>
              ))}
              <DropdownMenu.Separator className="menu-sep" />
              <DropdownMenu.CheckboxItem className="menu-item" checked={p.calendarWeekends}
                onCheckedChange={(on) => prefs.set((x) => ({ ...x, calendarWeekends: !!on }))}>
                <span style={{ flex: 1 }}>Show weekends</span>
                {p.calendarWeekends && <span aria-hidden>✓</span>}
              </DropdownMenu.CheckboxItem>
              <DropdownMenu.CheckboxItem className="menu-item" checked={p.calendarWeekNumbers}
                onCheckedChange={(on) => prefs.set((x) => ({ ...x, calendarWeekNumbers: !!on }))}>
                <span style={{ flex: 1 }}>Show week numbers</span>
                {p.calendarWeekNumbers && <span aria-hidden>✓</span>}
              </DropdownMenu.CheckboxItem>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
      <div className="calendar-grid">
        <FullCalendar
          ref={ref}
          plugins={[dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin, monarchPlugin]}
          initialView={FC_VIEW[view]}
          initialDate={date}
          views={{
            timeGridFourDays: { type: "timeGrid", duration: { days: 4 } },
            listSchedule: { type: "list", duration: { days: 30 }, noEventsText: "Nothing in the next 30 days" },
          }}
          headerToolbar={false}
          timeZone={zone}
          firstDay={firstDay(acct.settings?.weekStart)}
          weekends={p.calendarWeekends}
          weekNumbers={p.calendarWeekNumbers}
          nowIndicator
          height="100%"
          expandRows
          scrollTime={`${String(Math.max(0, Temporal.Now.zonedDateTimeISO(zone).hour - 1)).padStart(2, "0")}:00:00`}
          // Rows of a quarter hour, labelled by the hour. A drag snaps to a row; with rows
          // longer than the snap, FullCalendar tracks an event by its middle, which then
          // sits on a snap boundary and makes the event jump 15 minutes as it's picked up.
          slotDuration="00:15:00"
          slotHeaderInterval="01:00:00"
          slotHeaderInnerClass="calendar-slot-label"
          locales={LOCALES}
          locale={LOCALE}
          eventTimeFormat={{ hour: "numeric", minute: "2-digit", hour12: HOUR12 }}
          slotHeaderFormat={HOUR12 ? { hour: "numeric", omitZeroMinute: true, meridiem: "short" } : { hour: "2-digit", minute: "2-digit", hour12: false }}
          fixedWeekCount={false}
          dayMaxEvents
          selectable
          selectMirror
          selectMinDistance={5}
          editable
          navLinks
          navLinkDayClick={(d: Date) => go("day", calApi()?.formatIso(d, true).slice(0, 10) ?? date)}
          events={fcEvents}
          datesSet={onDatesSet}
          select={onSelect}
          dateClick={onDateClick}
          eventClick={onEventClick}
          eventDrop={onMoved}
          eventResize={onMoved}
        />
      </div>
      {quick && <QuickCreate state={quick} calendars={calendars} onClose={close} onSaved={refresh} />}
      {card && <EventCard state={card} calendars={calendars} onClose={() => setCard(null)} onChanged={refresh} />}
    </>
  );
}

/** An anchor at a point or an element's box, for a card that opens where the click was. */
function At({ rect }: { rect: DOMRect }) {
  const virtual = useRef({ getBoundingClientRect: () => rect });
  virtual.current.getBoundingClientRect = () => rect;
  return <Popover.Anchor virtualRef={virtual} />;
}

/** Click or drag on the grid: a title, and Save; "More options" opens the full editor. */
function QuickCreate({ state, calendars, onClose, onSaved }: { state: QuickState; calendars: CalendarInfo[]; onClose: () => void; onSaved: () => void }) {
  const acct = useAccount();
  const zone = useCalendarZone();
  const [title, setTitle] = useState("");
  const [calendarId, setCalendarId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const chosen = calendarId ?? calendars.find((c) => c.primary)?.id ?? calendars[0]?.id ?? null;
  const times = { allDay: state.allDay, start: state.start, end: state.end };
  const more = () => {
    onClose();
    newEvent({ ...times, title, calendarId: chosen ?? undefined });
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (chosen === null) return;
    setBusy(true);
    try {
      await api.createEvent(acct.index, chosen, { ...times, title, zone: state.allDay ? null : zone, location: "", description: "", busy: true, color: null, video: null }, zone);
      onSaved();
      onClose();
    } catch (err) {
      toast((err as Error).message, { error: true });
      setBusy(false);
    }
  };
  return (
    <Popover.Root open onOpenChange={(o) => !o && onClose()}>
      <At rect={state.rect} />
      <Popover.Portal>
        <Popover.Content className="popover event-card" side="right" align="start" sideOffset={8} collisionPadding={16} aria-label="New event">
          <div className="event-card-tools">
            <IconButton label="Close" size="sm" onClick={onClose}><X size={18} /></IconButton>
          </div>
          <form className="quick-create" onSubmit={(e) => void save(e)}>
            <input className="quick-title" aria-label="Title" placeholder="Add title" value={title} autoFocus maxLength={500} onChange={(e) => setTitle(e.target.value)} />
            <div className="event-card-row"><CalendarDays size={18} aria-hidden /> {formatWhen(times)}</div>
            {calendars.length > 1 && (
              <label className="event-card-row">
                <span className="swatch" style={{ background: calendars.find((c) => c.id === chosen)?.color }} aria-hidden />
                <select aria-label="Calendar" value={chosen ?? ""} onChange={(e) => setCalendarId(Number(e.target.value))}>
                  {calendars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
            )}
            <div className="buttons">
              <button type="button" className="btn btn-text" onClick={more}>More options</button>
              <button type="submit" className="btn btn-primary" disabled={busy || chosen === null}>Save</button>
            </div>
          </form>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Web addresses in a description, as links; the rest as text. */
function linked(text: string): ReactNode[] {
  return text.split(/(https?:\/\/[^\s<>"]+)/g).map((part, i) =>
    i % 2 ? <a key={i} href={part} target="_blank" rel="noopener noreferrer">{part}</a> : part,
  );
}

/** What clicking an event opens: when and where, the video call, and Edit and Delete. */
function EventCard({ state, calendars, onClose, onChanged }: { state: CardState; calendars: CalendarInfo[]; onClose: () => void; onChanged: () => void }) {
  const acct = useAccount();
  const zone = useCalendarZone();
  const e = state.event;
  const detail = useQuery({ queryKey: ["event", acct.index, e.id, zone], queryFn: () => api.event(acct.index, e.id, zone), staleTime: 0 });
  const d = detail.data?.event;
  const calendar = calendars.find((c) => c.id === e.calendarId);
  const when = e.allDay ? { allDay: true, start: e.start, end: e.end } : { allDay: false, start: instantToWall(e.start, zone), end: instantToWall(e.end, zone) };
  const edit = () => {
    onClose();
    openEvent(e.id);
  };
  const duplicate = () => {
    if (!d) return;
    onClose();
    const { id: _id, created: _c, updated: _u, eventZone: _z, ...copy } = d;
    newEvent({ ...copy, title: d.title ? `${d.title} (copy)` : "" });
  };
  return (
    <Popover.Root open onOpenChange={(o) => !o && onClose()}>
      <At rect={state.rect} />
      <Popover.Portal>
        <Popover.Content className="popover event-card" side="right" align="start" sideOffset={8} collisionPadding={16} aria-label={e.title || "Event"}
          tabIndex={-1} onOpenAutoFocus={(ev) => { ev.preventDefault(); (ev.currentTarget as HTMLElement).focus(); }}>
          <div className="event-card-tools">
            <IconButton label="Edit event" size="sm" onClick={edit}><Pencil size={18} /></IconButton>
            <IconButton label="Duplicate" size="sm" onClick={duplicate} disabled={!d}><Copy size={18} /></IconButton>
            <IconButton label="Delete event" size="sm" onClick={() => { onClose(); deleteEvent(acct.index, e.id, onChanged); }}><Trash2 size={18} /></IconButton>
            <IconButton label="Close" size="sm" onClick={onClose}><X size={18} /></IconButton>
          </div>
          <div className="event-card-title">
            <span className="swatch lg" style={{ background: e.color ?? calendar?.color }} aria-hidden />
            <h3>{e.title || "(No title)"}</h3>
          </div>
          <div className="event-card-row muted">{formatWhen(when)}{!e.busy && " · Free"}</div>
          {d?.video && (
            <a className="btn btn-primary event-join" href={d.video} target="_blank" rel="noopener noreferrer"><Video size={18} /> Join video call</a>
          )}
          {e.location && (
            <div className="event-card-row">
              <MapPin size={18} aria-hidden />
              <a href={`https://www.openstreetmap.org/search?query=${encodeURIComponent(e.location)}`} target="_blank" rel="noopener noreferrer">{e.location}</a>
            </div>
          )}
          {d?.description && <div className="event-card-row event-description"><Text size={18} aria-hidden /><div>{linked(d.description)}</div></div>}
          {calendar && <div className="event-card-row muted"><CalendarDays size={18} aria-hidden /> {calendar.name}</div>}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// ---------------------------------------------------------------- search

/** Events found by the search box, grouped by day, newest first. */
function CalendarSearch({ query }: { query: string }) {
  const acct = useAccount();
  const zone = useCalendarZone();
  const calendars = useCalendars().data?.calendars ?? [];
  const found = useQuery({ queryKey: ["calendar-search", acct.index, query, zone], queryFn: () => api.searchEvents(acct.index, query, zone) });
  const days = useMemo(() => {
    const groups = new Map<string, { e: EventSummary; start: string; end: string }[]>();
    for (const e of found.data?.events ?? []) {
      const start = e.allDay ? e.start : instantToWall(e.start, zone);
      const end = e.allDay ? e.end : instantToWall(e.end, zone);
      const day = start.slice(0, 10);
      groups.set(day, [...(groups.get(day) ?? []), { e, start, end }]);
    }
    return [...groups.entries()];
  }, [found.data, zone]);
  return (
    <>
      <div className="toolbar calendar-toolbar">
        <IconButton label="Back to the calendar" onClick={() => navigate(calendarPath(acct.index))}><ArrowLeft size={20} /></IconButton>
        <h2 className="calendar-title">Events matching “{query}”</h2>
      </div>
      <div className="settings">
        {found.isPending ? (
          <div className="empty"><div className="spinner lg" /></div>
        ) : found.error ? (
          <div className="empty"><p className="form-error">{found.error.message}</p></div>
        ) : !days.length ? (
          <div className="empty"><h3>No events match</h3><p>Searches look in titles, places and descriptions.</p></div>
        ) : (
          <ul className="search-results">
            {days.map(([day, list]) => (
              <li key={day} className="search-day">
                <button type="button" className="search-date" onClick={() => navigate(calendarPath(acct.index, "day", day))}>
                  {Temporal.PlainDate.from(day).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" })}
                </button>
                <ul>
                  {list.map(({ e, start, end }) => (
                    <li key={e.id}>
                      <button type="button" className="search-event" onClick={() => openEvent(e.id)}>
                        <span className="swatch" style={{ background: e.color ?? calendars.find((c) => c.id === e.calendarId)?.color }} aria-hidden />
                        <span className="search-when">{e.allDay ? "All day" : formatWhen({ allDay: false, start, end }).split(" · ").pop()}</span>
                        <span className="search-what">{e.title || "(No title)"}{e.location && <span className="muted"> · {e.location}</span>}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
