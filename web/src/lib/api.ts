import type {
  ActionName,
  CalendarInfo,
  EventDetail,
  EventInput,
  EventSummary,
  Scope,
  AdminChange,
  AdminData,
  AdminSetting,
  AppConfig,
  Contact,
  ContactFields,
  ContactLabel,
  ContactSummary,
  ContactSync,
  Suggestion,
  TidyProposal,
  Filter,
  FiltersState,
  Vacation,
  Conversation,
  MailboxesResponse,
  MessageRef,
  PasswordChange,
  RenderedMessage,
  SessionAccount,
  SettingValue,
  Settings,
  ThreadsResponse,
  Label,
  Address,
} from "./types";

export class ApiError extends Error {
  status: number;
  reauth: boolean;
  constructor(message: string, status: number, reauth: boolean) {
    super(message);
    this.status = status;
    this.reauth = reauth;
  }
}

async function request<T>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const init: RequestInit = { method, headers: { ...headers }, credentials: "same-origin" };
  if (body !== undefined) {
    if (body instanceof Blob || body instanceof ArrayBuffer) {
      init.body = body;
    } else {
      init.body = JSON.stringify(body);
      (init.headers as Record<string, string>)["Content-Type"] = "application/json";
    }
  }
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new ApiError("You're offline, or the server isn't reachable.", 0, false);
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const d = data as { error?: string; reauth?: boolean } | null;
    throw new ApiError(d?.error || `Request failed (${res.status})`, res.status, !!d?.reauth);
  }
  return data as T;
}

const u = (a: number) => `/api/u/${a}`;

export const api = {
  config: () => request<AppConfig>("GET", "/api/config"),
  session: () => request<{ accounts: SessionAccount[] }>("GET", "/api/session"),
  login: (body: { email: string; password: string; username?: string; add?: boolean; imap?: unknown; smtp?: unknown }) =>
    request<{ index: number }>("POST", "/api/auth/login", body),
  logout: (index?: number) => request<{ ok: true }>("POST", "/api/auth/logout", index === undefined ? {} : { index }),

  mailboxes: (a: number) => request<MailboxesResponse>("GET", `${u(a)}/mailboxes`),
  createMailbox: (a: number, name: string, parentId?: number) => request("POST", `${u(a)}/mailboxes`, { name, parentId }),
  renameMailbox: (a: number, id: number, name: string) => request("PATCH", `${u(a)}/mailboxes/${id}`, { name }),
  deleteMailbox: (a: number, id: number) => request("DELETE", `${u(a)}/mailboxes/${id}`),

  threads: (a: number, view: string, page: number, q?: string) => {
    const params = new URLSearchParams({ view, page: String(page) });
    if (q) params.set("q", q);
    return request<ThreadsResponse>("GET", `${u(a)}/threads?${params}`);
  },
  thread: (a: number, id: number, view: string) =>
    request<Conversation>("GET", `${u(a)}/threads/${id}?view=${encodeURIComponent(view)}`),
  message: (a: number, ref: MessageRef, images: boolean) =>
    request<RenderedMessage>("GET", `${u(a)}/messages/${ref.mailboxId}/${ref.uid}${images ? "?images=1" : ""}`),
  composeData: (a: number, ref: MessageRef) =>
    request<{
      from: string | null;
      to: Address[];
      cc: Address[];
      bcc: Address[];
      subject: string;
      html: string;
      replyTo: MessageRef | null;
      attachments: { mailboxId: number; uid: number; index: number; filename: string; size: number; contentType: string }[];
    }>("GET", `${u(a)}/messages/${ref.mailboxId}/${ref.uid}/compose`),

  action: (
    a: number,
    body: { action: ActionName; view: string; threads?: number[]; messages?: MessageRef[]; target?: number; keyword?: string },
  ) => request<{ undo?: string; count: number }>("POST", `${u(a)}/actions`, body),
  undo: (a: number, token: string) => request<{ ok: true }>("POST", `${u(a)}/undo`, { token }),

  send: (a: number, body: unknown) =>
    request<{ messageId: string; threadId?: number; warnings: string[] }>("POST", `${u(a)}/send`, body),
  saveDraft: (a: number, body: unknown) =>
    request<{
      draft: MessageRef | null;
      attachments: { mailboxId: number; uid: number; index: number; filename: string; size: number; contentType: string }[] | null;
    }>("PUT", `${u(a)}/drafts`, body),
  discardDraft: (a: number, ref: MessageRef) => request("DELETE", `${u(a)}/drafts/${ref.mailboxId}/${ref.uid}`),
  upload: (a: number, file: File) =>
    request<{ id: string; filename: string; size: number; contentType: string }>("POST", `${u(a)}/uploads`, file, {
      "Content-Type": file.type || "application/octet-stream",
      "X-Filename": encodeURIComponent(file.name),
    }),

  suggestions: (a: number, q: string) => request<{ contacts: Suggestion[] }>("GET", `${u(a)}/suggestions?q=${encodeURIComponent(q)}`),

  filters: (a: number) => request<FiltersState>("GET", `${u(a)}/filters`),
  saveFilters: (a: number, filters: Filter[]) => request<FiltersState>("PUT", `${u(a)}/filters`, { filters }),
  saveVacation: (a: number, vacation: Vacation) => request<FiltersState>("PUT", `${u(a)}/vacation`, { vacation }),

  contacts: (a: number, q: string, offset = 0, label = "") =>
    request<{ contacts: ContactSummary[]; total: number; sync: ContactSync }>(
      "GET", `${u(a)}/contacts?${new URLSearchParams({ q, offset: String(offset), ...(label ? { label } : {}) })}`,
    ),
  contactLabels: (a: number) => request<{ labels: ContactLabel[] }>("GET", `${u(a)}/contacts/labels`),
  renameContactLabel: (a: number, label: string, to: string) =>
    request<{ changed: number }>("PATCH", `${u(a)}/contacts/labels?label=${encodeURIComponent(label)}`, { to }),
  removeContactLabel: (a: number, label: string) => request<{ changed: number }>("DELETE", `${u(a)}/contacts/labels?label=${encodeURIComponent(label)}`),
  contactsToTidy: (a: number) => request<{ contacts: TidyProposal[] }>("GET", `${u(a)}/contacts/tidy`),
  tidyContacts: (a: number, contacts: { id: number; label: string }[]) => request<{ changed: number }>("POST", `${u(a)}/contacts/tidy`, { contacts }),
  syncContacts: (a: number) => request<{ sync: ContactSync }>("POST", `${u(a)}/contacts/sync`),
  contact: (a: number, id: number) => request<{ contact: Contact }>("GET", `${u(a)}/contacts/${id}`),
  contactWithAddress: (a: number, address: string) => request<{ id: number | null }>("GET", `${u(a)}/contacts/lookup?address=${encodeURIComponent(address)}`),
  createContact: (a: number, fields: ContactFields) => request<{ contact: Contact }>("POST", `${u(a)}/contacts`, fields),
  updateContact: (a: number, id: number, fields: ContactFields) => request<{ contact: Contact }>("PUT", `${u(a)}/contacts/${id}`, fields),
  deleteContact: (a: number, id: number) => request<{ ok: true }>("DELETE", `${u(a)}/contacts/${id}`),
  importContacts: (a: number, file: File) =>
    request<{ added: number; updated: number; unchanged: number; skipped: number }>("POST", `${u(a)}/contacts/import`, file, { "Content-Type": "text/vcard" }),
  exportContactsUrl: (a: number) => `${u(a)}/contacts/export`,
  calendars: (a: number) => request<{ calendars: CalendarInfo[] }>("GET", `${u(a)}/calendar/calendars`),
  createCalendar: (a: number, body: { name: string; color?: string }) => request<{ calendar: CalendarInfo }>("POST", `${u(a)}/calendar/calendars`, body),
  updateCalendar: (a: number, id: number, patch: Partial<Pick<CalendarInfo, "name" | "color" | "visible">>) =>
    request<{ calendar: CalendarInfo }>("PATCH", `${u(a)}/calendar/calendars/${id}`, patch),
  deleteCalendar: (a: number, id: number) => request<{ ok: true }>("DELETE", `${u(a)}/calendar/calendars/${id}`),
  subscribeCalendar: (a: number, url: string) => request<{ calendar: CalendarInfo }>("POST", `${u(a)}/calendar/feeds`, { url }),
  refreshCalendar: (a: number, id: number) => request<{ calendar: CalendarInfo }>("POST", `${u(a)}/calendar/calendars/${id}/refresh`),
  events: (a: number, from: string, to: string, zone: string) =>
    request<{ events: EventSummary[] }>("GET", `${u(a)}/calendar/events?${new URLSearchParams({ from, to, zone })}`),
  searchEvents: (a: number, q: string, zone: string) =>
    request<{ events: EventSummary[] }>("GET", `${u(a)}/calendar/events/search?${new URLSearchParams({ q, zone })}`),
  event: (a: number, id: number, zone: string, occurrence?: string | null) =>
    request<{ event: EventDetail }>("GET", `${u(a)}/calendar/events/${id}?${new URLSearchParams({ zone, ...(occurrence ? { occurrence } : {}) })}`),
  createEvent: (a: number, calendarId: number, input: EventInput, zone: string) =>
    request<{ event: EventDetail }>("POST", `${u(a)}/calendar/events?zone=${encodeURIComponent(zone)}`, { ...input, calendarId }),
  updateEvent: (
    a: number,
    id: number,
    patch: Partial<EventInput> & { calendarId?: number; occurrence?: string | null; scope?: Scope; setZones?: boolean },
    zone: string,
  ) =>
    request<{ event: EventDetail; undo: string }>("PATCH", `${u(a)}/calendar/events/${id}?zone=${encodeURIComponent(zone)}`, patch),
  deleteEvent: (a: number, id: number, occurrence?: string | null, scope?: Scope) =>
    request<{ undo: string }>("DELETE", `${u(a)}/calendar/events/${id}?${new URLSearchParams({ ...(occurrence ? { occurrence } : {}), ...(scope ? { scope } : {}) })}`),
  undoCalendar: (a: number, token: string) => request<{ ok: true }>("POST", `${u(a)}/calendar/undo`, { token }),
  importCalendar: (a: number, target: number | "new", file: File) =>
    request<{ calendarId: number; added: number; updated: number; unchanged: number; skipped: number }>(
      "POST", `${u(a)}/calendar/import?calendar=${target}`, file, { "Content-Type": "text/calendar" },
    ),
  exportCalendarUrl: (a: number, id: number, zone: string) => `${u(a)}/calendar/calendars/${id}/export?zone=${encodeURIComponent(zone)}`,

  settings: (a: number) => request<{ settings: Settings; email: string; password: PasswordChange | null }>("GET", `${u(a)}/settings`),
  changePassword: (a: number, current: string, next: string) =>
    request<{ ok: true; signedOut: number }>("POST", `${u(a)}/password`, { current, next }),
  saveSettings: (a: number, patch: Partial<Settings>) => request<{ settings: Settings }>("PUT", `${u(a)}/settings`, patch),
  trustSender: (a: number, address: string) => request("POST", `${u(a)}/trusted-senders`, { address }),

  createLabel: (a: number, name: string, color?: string | null) => request<{ label: Label }>("POST", `${u(a)}/labels`, { name, color }),
  updateLabel: (a: number, keyword: string, patch: { name?: string; color?: string | null }) =>
    request<{ label: Label }>("PATCH", `${u(a)}/labels/${encodeURIComponent(keyword)}`, patch),
  deleteLabel: (a: number, keyword: string) => request("DELETE", `${u(a)}/labels/${encodeURIComponent(keyword)}`),

  admin: (a: number) => request<AdminData>("GET", `/api/admin/${a}`),
  saveAdmin: (a: number, patch: Record<string, SettingValue | null>) =>
    request<{ changed: string[]; settings: AdminSetting[]; changes: AdminChange[] }>("PUT", `/api/admin/${a}/settings`, patch),

  attachmentUrl: (a: number, ref: MessageRef, index: number, inline = false) =>
    `${u(a)}/messages/${ref.mailboxId}/${ref.uid}/attachments/${index}${inline ? "?inline=1" : ""}`,
  rawUrl: (a: number, ref: MessageRef, download = false) =>
    `${u(a)}/messages/${ref.mailboxId}/${ref.uid}/raw${download ? "?download=1" : ""}`,
};
