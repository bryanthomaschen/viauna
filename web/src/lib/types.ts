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
  /** A second time zone beside the calendar's times; empty: none. */
  secondTimeZone: string;
  weekStart: "auto" | "sunday" | "monday" | "saturday";
  /** How long a new event lasts, in minutes. */
  eventMinutes: 15 | 30 | 45 | 60 | 90 | 120;
  /** The reminders a new event gets: timed, and all-day. */
  reminders: Reminder[];
  allDayReminders: Reminder[];
}

/** A notification or an email, so many minutes before an event starts (an all-day one's day starts at midnight; negative: after). */
export interface Reminder {
  method: "notification" | "email";
  minutes: number;
}

/** A reminder that's due, as the live-update stream brings it. */
export interface ReminderNotice {
  index: number;
  eventId: number;
  occurrence: string | null;
  method: Reminder["method"];
  minutes: number;
  at: number;
  title: string;
  allDay: boolean;
  start: string;
  end: string;
  location: string;
  video: string | null;
  zone: string;
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
  /** Calendars can be added from the web by their address. */
  calendarFeeds: boolean;
  /** Calendars can have secret addresses. */
  calendarSecrets: boolean;
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
  /** Names that match while writing, comma-separated; never sent. */
  nickname: string;
  emails: { address: string; label: string }[];
  phones: { number: string; label: string }[];
  organization: string;
  title: string;
  /** "1990-05-12", "--05-12" without the year, or another app's own wording. */
  birthday: string;
  /** Labelled "anniversary", "other", or in the person's own words. */
  dates: { date: string; label: string }[];
  /** What the person is to you; shown only here. */
  labels: string[];
  notes: string;
}

export interface ContactSummary {
  id: number;
  name: string;
  emails: string[];
  phone: string | null;
  organization: string;
  labels: string[];
}

export interface ContactLabel {
  label: string;
  count: number;
}

/** A name with context after it, and what tidying it would make. */
export interface TidyProposal {
  id: number;
  name: string;
  firstName: string;
  lastName: string;
  label: string;
}

export interface Suggestion {
  address: string;
  name: string | null;
  labels: string[];
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
  /** "events", kept here; "birthdays", made from contacts' dates; "feed", fetched from the web. */
  kind: "events" | "birthdays" | "feed";
  /** Its events come from elsewhere, and can't be changed here. */
  readOnly: boolean;
  /** From the web: its address, when it last came back and was last tried, and what went wrong. */
  feed: { url: string; fetchedAt: number | null; checkedAt: number | null; error: string | null } | null;
  /** Its secret address, if it has one (never the address itself, which is shown once). */
  secret: { mode: SecretMode; createdAt: number; fetchedAt: number | null } | null;
}

/** What a secret address shows: the whole calendar, or only when you're busy. */
export type SecretMode = "all" | "busy";

/** An event, or one occurrence of it, as the grid shows it. Timed: ISO instants. All-day: dates, the end exclusive. */
export interface EventSummary {
  id: number;
  calendarId: number;
  /** For an event that repeats: which occurrence ("20261021T090000"). */
  occurrence: string | null;
  recurring: boolean;
  title: string;
  allDay: boolean;
  start: string;
  end: string;
  color: string | null;
  busy: boolean;
  location: string;
  video: boolean;
  /** In a calendar whose events come from elsewhere. */
  readOnly: boolean;
  /** On the Birthdays calendar: whose date it is. */
  contactId: number | null;
}

export type Weekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";

/** How an event repeats. A rule another app wrote with parts Viauna doesn't edit comes as `custom`. */
export interface RepeatRule {
  freq: "daily" | "weekly" | "monthly" | "yearly";
  interval: number;
  days?: Weekday[];
  nth?: { week: number; day: Weekday };
  until?: string;
  count?: number;
  custom?: string;
}

export type Scope = "this" | "following" | "all";

/** What the event editor sends: times as wall-clock in `zone` ("2026-10-21T09:00"), or dates. */
export interface EventInput {
  title: string;
  allDay: boolean;
  start: string;
  end: string;
  zone: string | null;
  /** The zone `end` is in, when that's another (a flight). */
  endZone: string | null;
  repeat: RepeatRule | null;
  location: string;
  description: string;
  busy: boolean;
  color: string | null;
  video: string | null;
  /** Left out: the mailbox's usual ones. */
  reminders?: Reminder[];
}

export interface EventDetail extends EventInput {
  /** In a calendar whose events come from elsewhere. */
  readOnly: boolean;
  id: number;
  calendarId: number;
  occurrence: string | null;
  recurring: boolean;
  /** The zone the event was made in, when it isn't the reader's. */
  eventZone: string | null;
  /** The zone its end was made in, when that's another. */
  eventEndZone: string | null;
  created: number;
  updated: number;
}
