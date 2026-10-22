// A tiny history router. Viauna's URLs mirror Gmail's structure:
//
//   /u/0/inbox                 the inbox of the first signed-in account
//   /u/0/inbox/123             conversation 123, opened from the inbox
//   /u/0/label/work            a label          /u/0/folder/12   a folder
//   /u/0/search/from%3Aann     search results   /u/0/settings    settings
//   /u/0/contacts              the address book
//   /u/0/contacts/label/Church the contacts with a label
//   /u/0/calendar/week/2026-10-21   the calendar, a view of the time around a date
//   /u/0/calendar/search/lunch      events found
//   /u/0/admin                 the admin page, for the whole server, as this account (an admin)
//   /admin                     the same, as the first admin signed in
//   /mailbox/ann@x.org/calendar/day/2026-10-21   the same as /u/N/…, for whichever N
//                              that mailbox is in this browser (links in notifications)
import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

window.addEventListener("popstate", emit);

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  if (to === location.pathname + location.search) return;
  if (opts.replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  emit();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function usePath(): string {
  return useSyncExternalStore(subscribe, () => location.pathname + location.search);
}

export type Folder =
  | { kind: "inbox" | "starred" | "sent" | "drafts" | "all" | "spam" | "trash" | "archive" }
  | { kind: "label"; keyword: string }
  | { kind: "folder"; id: number }
  | { kind: "search"; query: string };

export type CalendarView = "day" | "week" | "month" | "schedule" | "4days";

export const CALENDAR_VIEWS: CalendarView[] = ["day", "week", "month", "schedule", "4days"];

export interface CalendarRoute {
  /** Null: the view last used in this browser. */
  view: CalendarView | null;
  /** "2026-10-21"; null: today. */
  date: string | null;
  /** Searching events, for this. */
  search: string | null;
}

export interface Route {
  name: "login" | "mail" | "settings" | "contacts" | "calendar" | "admin" | "mailbox" | "none";
  account: number;
  folder: Folder;
  thread: number | null;
  page: number;
  calendar: CalendarRoute | null;
  /** The contacts with this label; null: all of them. */
  contactsLabel: string | null;
  /** For "mailbox": its address, and the rest of the path, to go to as /u/N/<rest>. */
  mailbox: { email: string; rest: string } | null;
}

const SIMPLE = new Set(["inbox", "starred", "sent", "drafts", "all", "spam", "trash", "archive"]);

export function parseRoute(path: string): Route {
  const [pathname, search] = path.split("?");
  const page = Math.max(0, Number(new URLSearchParams(search ?? "").get("p") ?? 1) - 1) || 0;
  const parts = pathname.split("/").filter(Boolean);
  const none: Route = { name: "none", account: 0, folder: { kind: "inbox" }, thread: null, page: 0, calendar: null, contactsLabel: null, mailbox: null };
  if (parts[0] === "login") return { ...none, name: "login" };
  if (parts[0] === "mailbox" && parts[1]) {
    return { ...none, name: "mailbox", account: -1, mailbox: { email: decodeURIComponent(parts[1]).toLowerCase(), rest: parts.slice(2).join("/") } };
  }
  // No account yet: App picks the first admin signed in.
  if (parts[0] === "admin" && parts.length === 1) return { ...none, name: "admin", account: -1 };
  if (parts[0] !== "u" || parts.length < 2) return none;
  const account = Number(parts[1]);
  if (!Number.isInteger(account)) return none;
  const rest = parts.slice(2);
  if (rest[0] === "settings") return { ...none, name: "settings", account };
  if (rest[0] === "contacts") {
    return { ...none, name: "contacts", account, contactsLabel: rest[1] === "label" && rest[2] ? decodeURIComponent(rest[2]) : null };
  }
  if (rest[0] === "admin" && rest.length === 1) return { ...none, name: "admin", account };
  if (rest[0] === "calendar") {
    const calendar: CalendarRoute = { view: null, date: null, search: null };
    if (rest[1] === "search" && rest[2] !== undefined) calendar.search = decodeURIComponent(rest[2]);
    else if (CALENDAR_VIEWS.includes(rest[1] as CalendarView)) {
      calendar.view = rest[1] as CalendarView;
      if (/^\d{4}-\d{2}-\d{2}$/.test(rest[2] ?? "")) calendar.date = rest[2];
    }
    return { ...none, name: "calendar", account, calendar };
  }
  let folder: Folder = { kind: "inbox" };
  let threadPart: string | undefined;
  if (!rest.length) folder = { kind: "inbox" };
  else if (SIMPLE.has(rest[0])) {
    folder = { kind: rest[0] as "inbox" };
    threadPart = rest[1];
  } else if (rest[0] === "label" && rest[1]) {
    folder = { kind: "label", keyword: decodeURIComponent(rest[1]) };
    threadPart = rest[2];
  } else if (rest[0] === "folder" && rest[1]) {
    folder = { kind: "folder", id: Number(rest[1]) };
    threadPart = rest[2];
  } else if (rest[0] === "search" && rest[1] !== undefined) {
    folder = { kind: "search", query: decodeURIComponent(rest[1]) };
    threadPart = rest[2];
  }
  const thread = threadPart && /^\d+$/.test(threadPart) ? Number(threadPart) : null;
  return { name: "mail", account, folder, thread, page, calendar: null, contactsLabel: null, mailbox: null };
}

export function folderPath(account: number, folder: Folder): string {
  const base = `/u/${account}`;
  switch (folder.kind) {
    case "label":
      return `${base}/label/${encodeURIComponent(folder.keyword)}`;
    case "folder":
      return `${base}/folder/${folder.id}`;
    case "search":
      return `${base}/search/${encodeURIComponent(folder.query)}`;
    default:
      return `${base}/${folder.kind}`;
  }
}

export function threadPath(account: number, folder: Folder, thread: number): string {
  return `${folderPath(account, folder)}/${thread}`;
}

/** The server's `view` parameter for a folder. */
export function viewParam(folder: Folder): string {
  switch (folder.kind) {
    case "label":
      return `label:${folder.keyword}`;
    case "folder":
      return `folder:${folder.id}`;
    case "search":
      return "search";
    default:
      return folder.kind;
  }
}

export function sameFolder(a: Folder, b: Folder): boolean {
  return folderPath(0, a) === folderPath(0, b);
}

export function contactsPath(account: number, label?: string | null): string {
  return label ? `/u/${account}/contacts/label/${encodeURIComponent(label)}` : `/u/${account}/contacts`;
}

export function calendarPath(account: number, view?: CalendarView, date?: string): string {
  return view ? `/u/${account}/calendar/${view}${date ? `/${date}` : ""}` : `/u/${account}/calendar`;
}

export function calendarSearchPath(account: number, query: string): string {
  return `/u/${account}/calendar/search/${encodeURIComponent(query)}`;
}
