// Shapes of the server's JSON responses.

export interface Address {
  name?: string;
  address: string;
}

export type SpecialUse = "inbox" | "sent" | "drafts" | "trash" | "junk" | "archive";

export interface Mailbox {
  id: number;
  path: string;
  name: string;
  parentPath: string | null;
  delimiter: string | null;
  specialUse: SpecialUse | null;
  selectable: boolean;
  subscribed: boolean;
  unread: number;
  total: number;
  indexed: number;
  syncing: boolean;
}

export interface Label {
  keyword: string;
  name: string;
  color: string | null;
  total: number;
  unread: number;
}

export interface MailboxesResponse {
  mailboxes: Mailbox[];
  labels: Label[];
  status: { error: string | null; ready: boolean };
}

export interface Participant {
  name: string;
  address: string;
  me: boolean;
  unread: boolean;
}

export interface ThreadSummary {
  id: number;
  subject: string;
  snippet: string;
  date: number;
  unread: boolean;
  starred: boolean;
  count: number;
  participants: Participant[];
  recipients: string[];
  labels: string[];
  attachments: boolean;
  drafts: number;
  mailboxIds: number[];
}

export interface ThreadsResponse {
  threads: ThreadSummary[];
  total: number;
  page: number;
  size: number;
}

export interface MessageMeta {
  mailboxId: number;
  uid: number;
  messageId: string | null;
  subject: string;
  date: number;
  from: Address[];
  to: Address[];
  cc: Address[];
  bcc: Address[];
  replyTo: Address[];
  snippet: string;
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  draft: boolean;
  labels: string[];
  attachments: number;
  size: number | null;
  mailboxIds: number[];
}

export interface Conversation {
  id: number;
  subject: string;
  messages: MessageMeta[];
  labels: string[];
}

export interface AttachmentInfo {
  index: number;
  filename: string;
  contentType: string;
  size: number;
  inline: boolean;
}

export interface RenderedMessage {
  html: string;
  plain: boolean;
  remoteContent: boolean;
  attachments: AttachmentInfo[];
  unsubscribe: { url?: string; mailto?: string; oneClick: boolean } | null;
  imagesAllowed: boolean;
  trustedSender: boolean;
}

export interface SessionAccount {
  index: number;
  email: string;
  name: string;
  /** May open the admin page. */
  admin: boolean;
}

export interface Identity {
  name: string;
  address: string;
}

export interface Settings {
  name: string;
  signature: string;
  aliases: Identity[];
  images: "ask" | "always";
  pageSize: 25 | 50 | 100;
  /** The calendar's time zone; empty: the browser's. */
  timeZone: string;
  weekStart: "auto" | "sunday" | "monday" | "saturday";
  /** How long a new event lasts, in minutes. */
  eventMinutes: 15 | 30 | 45 | 60 | 90 | 120;
}

/** How this mailbox's password is changed here: the mail server's own page, or a form. */
export type PasswordChange = { method: "link"; url: string } | { method: "form" };

export interface AppConfig {
  appName: string;
  version: string;
  customServers: boolean;
  configured: boolean;
  /** The address book is on. */
  contacts: boolean;
  calendar: boolean;
  /** Filters and the vacation responder can be used (the mail server's ManageSieve). */
  filters: boolean;
  vacation: boolean;
}

// ---------------------------------------------------------------- filters

export interface FilterCriteria {
  from: string;
  to: string;
  subject: string;
  hasWords: string;
  doesntHave: string;
  hasAttachment: boolean;
  largerThan: number | null;
  smallerThan: number | null;
}

export interface FilterActions {
  skipInbox: boolean;
  markRead: boolean;
  star: boolean;
  label: string | null;
  moveTo: string | null;
  delete: boolean;
  forwardTo: string | null;
}

export interface Filter {
  id: string;
  criteria: FilterCriteria;
  actions: FilterActions;
}

export interface Vacation {
  on: boolean;
  start: string | null;
  end: string | null;
  subject: string;
  message: string;
  zone: string | null;
}

export interface FiltersState {
  filters: Filter[];
  vacation: Vacation;
  /** Rules made in another app that keep running. */
  include: string[];
  changedElsewhere: boolean;
  features: { filters: boolean; vacation: boolean; forwarding: boolean };
}

// ---------------------------------------------------------------- contacts

export interface ContactFields {
  firstName: string;
  lastName: string;
  emails: { address: string; label: string }[];
  phones: { number: string; label: string }[];
  organization: string;
  title: string;
  birthday: string;
  notes: string;
}

export interface ContactSummary {
  id: number;
  name: string;
  emails: string[];
  phone: string | null;
  organization: string;
}

export interface Contact {
  id: number;
  name: string;
  fields: ContactFields;
}

/** Syncing with the CardDAV server; server is null when contacts don't sync. */
export interface ContactSync {
  server: string | null;
  syncing: boolean;
  at: number | null;
  error: string | null;
  books: { name: string; count: number }[];
}

export type ActionName =
  | "archive" | "trash" | "delete" | "spam" | "notspam" | "inbox" | "move"
  | "read" | "unread" | "star" | "unstar" | "label" | "unlabel";

export interface MessageRef {
  mailboxId: number;
  uid: number;
}

// ---------------------------------------------------------------- the admin page

export type SettingValue = boolean | number | string | string[];

export interface AdminSetting {
  key: string;
  env: string;
  type: "boolean" | "integer" | "text" | "list" | "choice";
  section: string;
  label: string;
  help: string;
  value: SettingValue;
  default: SettingValue;
  /** "environment": set there, and locked. */
  source: "environment" | "changed" | "default";
  updatedAt: number | null;
  updatedBy: string | null;
  min?: number;
  max?: number;
  unit?: string;
  choices?: { value: string; label: string }[];
}

export interface AdminChange {
  at: number;
  actor: string;
  setting: string;
  label: string;
  env: string;
  /** null: the default. */
  oldValue: SettingValue | null;
  newValue: SettingValue | null;
}

export interface ServerFacts {
  version: string;
  imap: string | null;
  smtp: string | null;
  database: string;
  dataDir: string;
  publicUrl: string | null;
  trustProxy: boolean;
  allowPrivateServers: boolean;
  passwordUrl: string | null;
  passwordCommand: boolean;
  passwordWebhook: boolean;
  passwordLdap: string | null;
  carddav: string | null;
}

export interface AdminData {
  you: string;
  settings: AdminSetting[];
  changes: AdminChange[];
  server: ServerFacts;
}

// ---------------------------------------------------------------- calendar

export interface CalendarInfo {
  id: number;
  name: string;
  color: string;
  visible: boolean;
  /** The mailbox's own calendar, which can't be deleted. */
  primary: boolean;
}

/** An event as the grid shows it. Timed: ISO instants. All-day: dates, the end exclusive. */
export interface EventSummary {
  id: number;
  calendarId: number;
  title: string;
  allDay: boolean;
  start: string;
  end: string;
  color: string | null;
  busy: boolean;
  location: string;
  video: boolean;
}

/** What the event editor sends: times as wall-clock in `zone` ("2026-10-21T09:00"), or dates. */
export interface EventInput {
  title: string;
  allDay: boolean;
  start: string;
  end: string;
  zone: string | null;
  location: string;
  description: string;
  busy: boolean;
  color: string | null;
  video: string | null;
}

export interface EventDetail extends EventInput {
  id: number;
  calendarId: number;
  /** The zone the event was made in, when it isn't the reader's. */
  eventZone: string | null;
  created: number;
  updated: number;
}
