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
