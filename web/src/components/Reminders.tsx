// An event's reminders as the editor and Settings show them: each a notification or an
// email, so long before the event; for an all-day event, so many days before at a time of
// day. Kept as minutes before the start (reminders in lib/calendar.ts).
import { Plus, X } from "lucide-react";
import { type ReminderUnit, joinAllDay, joinTimed, splitAllDay, splitTimed } from "../lib/calendar";
import type { Reminder } from "../lib/types";
import { IconButton } from "./common";

const MAX = 5;
const pad = (n: number) => String(n).padStart(2, "0");
const toTime = (minutes: number) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
const fromTime = (value: string) => {
  const [h, m] = value.split(":").map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : 540;
};

/** The first reminder offered: 10 minutes before, or for an all-day event, the day before at 09:00. */
export const firstReminder = (allDay: boolean): Reminder => ({ method: "notification", minutes: allDay ? 900 : 10 });

export function RemindersField({ value, onChange, allDay, email, label = "Notifications" }: {
  value: Reminder[];
  onChange: (next: Reminder[]) => void;
  allDay: boolean;
  /** Email reminders can be sent from this server, for this mailbox. */
  email: boolean;
  label?: string;
}) {
  const set = (i: number, r: Reminder) => onChange(value.map((x, j) => (j === i ? r : x)));
  return (
    <div className="reminders" role="group" aria-label={label}>
      {value.map((r, i) => {
        const n = i + 1;
        // Only when there's a choice: email from this server, or one another app set.
        const method = (email || value.some((x) => x.method === "email")) && (
          <select className="text-input reminder-method" aria-label={`Reminder ${n}: how`} value={r.method}
            onChange={(e) => set(i, { ...r, method: e.target.value as Reminder["method"] })}>
            <option value="notification">Notification</option>
            <option value="email">Email</option>
          </select>
        );
        const remove = <IconButton label={`Remove reminder ${n}`} onClick={() => onChange(value.filter((_, j) => j !== i))}><X size={18} /></IconButton>;
        if (allDay) {
          const { amount, unit, time } = splitAllDay(r.minutes);
          return (
            <div key={i} className="reminder-row">
              {method}
              <input className="text-input reminder-amount" type="number" min={0} max={unit === "weeks" ? 4 : 28} aria-label={`Reminder ${n}: how many ${unit} before`}
                value={amount} onChange={(e) => set(i, { ...r, minutes: joinAllDay(Math.max(0, Number(e.target.value) || 0), unit, time) })} />
              <select className="text-input reminder-unit" aria-label={`Reminder ${n}: days or weeks`} value={unit}
                onChange={(e) => set(i, { ...r, minutes: joinAllDay(amount, e.target.value as "days" | "weeks", time) })}>
                <option value="days">{amount === 1 ? "day" : "days"} before</option>
                <option value="weeks">{amount === 1 ? "week" : "weeks"} before</option>
              </select>
              <span className="reminder-at">at</span>
              <input className="text-input reminder-time" type="time" step={300} aria-label={`Reminder ${n}: at what time`} value={toTime(time)}
                onChange={(e) => e.target.value && set(i, { ...r, minutes: joinAllDay(amount, unit, fromTime(e.target.value)) })} />
              {remove}
            </div>
          );
        }
        const { amount, unit } = splitTimed(Math.max(0, r.minutes));
        return (
          <div key={i} className="reminder-row">
            {method}
            <input className="text-input reminder-amount" type="number" min={0} max={unit === "minutes" ? 40320 : unit === "hours" ? 672 : unit === "days" ? 28 : 4}
              aria-label={`Reminder ${n}: how many ${unit} before`} value={amount}
              onChange={(e) => set(i, { ...r, minutes: joinTimed(Math.max(0, Number(e.target.value) || 0), unit) })} />
            <select className="text-input reminder-unit" aria-label={`Reminder ${n}: minutes, hours, days or weeks`} value={unit}
              onChange={(e) => set(i, { ...r, minutes: joinTimed(amount, e.target.value as ReminderUnit) })}>
              {(["minutes", "hours", "days", "weeks"] as const).map((u) => <option key={u} value={u}>{amount === 1 ? u.replace(/s$/, "") : u} before</option>)}
            </select>
            {remove}
          </div>
        );
      })}
      {value.length < MAX && (
        <button type="button" className="btn btn-text add-field" onClick={() => onChange([...value, firstReminder(allDay)])}>
          <Plus size={16} /> Add a notification
        </button>
      )}
    </div>
  );
}
