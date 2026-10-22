// Server-sent events: the server pushes "this account's folders changed" and the
// affected queries refetch. New mail appears within a second of arriving; contacts
// synced from the CardDAV server appear when the sync ends; a calendar changed in another
// tab or browser, at once; a reminder when it's due.
import { type QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { ui } from "./account";
import { refreshWhenSettled } from "./actions";
import { refreshAccountSettings, refreshSettings } from "./config";
import { calendarPath, navigate } from "./router";
import { pushOn } from "./push";
import { prefs, toast } from "./store";
import type { ReminderNotice } from "./types";

const HOUR12 = new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hour12 ?? true;

/** "Standup at 09:00 (in 10 min)", "Holiday tomorrow": a reminder as a notice says it, in the calendar's zone. */
export function reminderLine(n: Pick<ReminderNotice, "title" | "allDay" | "start" | "zone">): string {
  const title = n.title || "(No title)";
  const zone = n.zone || undefined;
  if (n.allDay) {
    // Dates as YYYY-MM-DD in that zone (en-CA writes them so).
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(new Date());
    const days = Math.round((Date.parse(n.start) - Date.parse(today)) / 86_400_000);
    const when = days === 0 ? "today" : days === 1 ? "tomorrow"
      : `on ${new Date(`${n.start}T00:00:00Z`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })}`;
    return `${title} ${when}`;
  }
  const start = new Date(n.start);
  const minutes = Math.round((start.getTime() - Date.now()) / 60_000);
  const soon = minutes <= 0 ? "now" : minutes < 60 ? `in ${minutes} min` : null;
  const at = start.toLocaleString(undefined, { ...(minutes < 18 * 60 ? {} : { weekday: "short" }), hour: HOUR12 ? "numeric" : "2-digit", minute: "2-digit", hour12: HOUR12, timeZone: zone });
  return `${title} at ${at}${soon ? ` (${soon})` : ""}`;
}

/** Opens the event a reminder is for, on its day. */
export function openReminder(n: Pick<ReminderNotice, "index" | "eventId" | "occurrence" | "start">) {
  navigate(calendarPath(n.index, "day", n.start.slice(0, 10)));
  ui.set((s) => ({ ...s, eventDialog: { id: n.eventId, occurrence: n.occurrence } }));
}

interface ChangeEvent {
  index: number;
  mailboxIds: number[];
  arrived?: { threadId: number; from: string; subject: string }[];
}

export function useLiveUpdates(client: QueryClient, accountCount: number, onOpenThread: (index: number, threadId: number) => void) {
  useEffect(() => {
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let reconnected = false;
    const pending = new Set<number>();
    let flush: ReturnType<typeof setTimeout> | null = null;

    const refresh = () => {
      flush = null;
      // While actions are in flight, their own refresh follows them; one now would show
      // the server midway (a star back for a moment after unstarring).
      for (const index of pending) refreshWhenSettled(client, index);
      pending.clear();
    };

    const connect = () => {
      source = new EventSource("/api/events");
      source.addEventListener("change", (e) => {
        const data = JSON.parse((e as MessageEvent).data) as ChangeEvent;
        pending.add(data.index);
        if (!flush) flush = setTimeout(refresh, 250);
        if (data.arrived?.length && prefs.get().notifications && document.hidden && "Notification" in window && Notification.permission === "granted") {
          for (const m of data.arrived.slice(0, 3)) {
            const n = new Notification(m.from || "New message", { body: m.subject, tag: `viauna-${data.index}-${m.threadId}` });
            n.onclick = () => {
              window.focus();
              onOpenThread(data.index, m.threadId);
              n.close();
            };
          }
        }
      });
      // A setting changed: on the admin page, from the command line, in another tab.
      source.addEventListener("settings", () => refreshSettings(client));
      source.addEventListener("account-settings", (e) => {
        const { index } = JSON.parse((e as MessageEvent).data) as { index: number };
        refreshAccountSettings(client, index);
      });
      // Back after a dropped connection, announcements may have been missed.
      source.addEventListener("ready", () => {
        if (reconnected) refreshSettings(client);
        reconnected = true;
      });
      source.addEventListener("calendar", (e) => {
        const { index } = JSON.parse((e as MessageEvent).data) as { index: number };
        for (const key of ["calendars", "events", "event", "calendar-search"]) void client.invalidateQueries({ queryKey: [key, index] });
      });
      // A reminder due: a notice here, and a desktop notification if they're on and the tab is in the background.
      source.addEventListener("reminder", (e) => {
        const n = JSON.parse((e as MessageEvent).data) as ReminderNotice;
        toast(reminderLine(n), { action: { label: "Open", run: () => openReminder(n) }, ms: 10 * 60_000 });
        // With notifications on through the browser's push service, its worker shows this one.
        const email = (client.getQueryData(["session"]) as { accounts?: { email: string }[] } | undefined)?.accounts?.[n.index]?.email;
        if (email && pushOn(email)) return;
        if (prefs.get().notifications && document.hidden && "Notification" in window && Notification.permission === "granted") {
          const shown = new Notification(n.title || "Reminder", { body: reminderLine(n), tag: `viauna-reminder-${n.eventId}-${n.occurrence ?? ""}-${n.at}` });
          shown.onclick = () => {
            window.focus();
            openReminder(n);
            shown.close();
          };
        }
      });
      source.addEventListener("contacts", (e) => {
        const { index } = JSON.parse((e as MessageEvent).data) as { index: number };
        // The Birthdays calendar shows the contacts' dates.
        for (const key of ["contacts", "contact-labels", "events"]) void client.invalidateQueries({ queryKey: [key, index] });
      });
      source.addEventListener("reauth", (e) => {
        const { index } = JSON.parse((e as MessageEvent).data) as { index: number };
        toast(`Account ${index + 1} needs you to sign in again.`, {
          error: true,
          action: { label: "Sign in", run: () => (location.href = "/login?add=1") },
          ms: 20000,
        });
      });
      source.onerror = () => {
        source?.close();
        if (!closed) retry = setTimeout(connect, 5000);
      };
    };
    connect();
    return () => {
      closed = true;
      source?.close();
      if (retry) clearTimeout(retry);
      if (flush) clearTimeout(flush);
    };
  }, [client, accountCount, onOpenThread]);
}
