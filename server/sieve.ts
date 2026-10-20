// Filters and the vacation responder as a Sieve script (RFC 5228), the standard rule
// language mail servers run as mail arrives. Viauna owns one script, "viauna": it writes
// the rules from its own model, and keeps that model in a comment at the top, so it reads
// back exactly what it wrote. A hash of the rules shows whether someone edited the script
// elsewhere since. Rules another app made (another script) keep running: Viauna's script
// includes it.
import crypto from "node:crypto";

export interface FilterCriteria {
  /** Matched against From, name or address; alternatives separated by commas or OR. */
  from: string;
  /** Against To and Cc, the same way. */
  to: string;
  subject: string;
  /** Words in the message text; a "quoted phrase" is one word. All must be there. */
  hasWords: string;
  /** None of these may be. */
  doesntHave: string;
  hasAttachment: boolean;
  /** Bytes. */
  largerThan: number | null;
  smallerThan: number | null;
}

export interface FilterActions {
  /** Out of the inbox, into Archive. */
  skipInbox: boolean;
  markRead: boolean;
  star: boolean;
  /** A label's IMAP keyword. */
  label: string | null;
  /** A folder's path. */
  moveTo: string | null;
  /** Into Trash. */
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
  /** YYYY-MM-DD, inclusive; null for no limit. */
  start: string | null;
  end: string | null;
  subject: string;
  message: string;
  /** The person's offset from UTC (+0800) when they set it, so days start at their midnight. */
  zone: string | null;
}

export interface SieveModel {
  filters: Filter[];
  vacation: Vacation;
  /** Other scripts (another app's rules) run after Viauna's. */
  include: string[];
}

/** What the script needs to know about the mailbox. */
export interface SieveContext {
  archive: string | null;
  trash: string | null;
  /** Every address of the mailbox (login and aliases), for the vacation responder. */
  addresses: string[];
}

export const EMPTY_VACATION: Vacation = { on: false, start: null, end: null, subject: "", message: "", zone: null };
export const EMPTY_MODEL: SieveModel = { filters: [], vacation: EMPTY_VACATION, include: [] };

/** A Sieve quoted string. */
export function str(s: string): string {
  return `"${s.replace(/[\\"]/g, "\\$&")}"`;
}

const list = (items: string[]) => (items.length === 1 ? str(items[0]) : `[${items.map(str).join(", ")}]`);

/** "a, b OR c" → ["a", "b", "c"]. */
export function alternatives(text: string): string[] {
  return text.split(/\s*,\s*|\s+OR\s+/).map((s) => s.trim()).filter(Boolean);
}

/** Words, with "quoted phrases" kept whole. */
export function words(text: string): string[] {
  return [...text.matchAll(/"([^"]+)"|(\S+)/g)].map((m) => (m[1] ?? m[2]).trim()).filter(Boolean);
}

/** What a filter's tests and actions are, in Sieve, and the extensions they use. */
function filterRule(f: Filter, ctx: SieveContext, uses: Set<string>): string | null {
  const c = f.criteria;
  const tests: string[] = [];
  if (alternatives(c.from).length) tests.push(`header :contains "from" ${list(alternatives(c.from))}`);
  if (alternatives(c.to).length) tests.push(`header :contains ["to", "cc"] ${list(alternatives(c.to))}`);
  if (c.subject.trim()) tests.push(`header :contains "subject" ${str(c.subject.trim())}`);
  for (const w of words(c.hasWords)) {
    uses.add("body");
    tests.push(`body :text :contains ${str(w)}`);
  }
  if (words(c.doesntHave).length) {
    uses.add("body");
    tests.push(`not body :text :contains ${list(words(c.doesntHave))}`);
  }
  if (c.hasAttachment) {
    uses.add("mime");
    tests.push(`header :mime :anychild :contains "Content-Disposition" "attachment"`);
  }
  if (c.largerThan !== null) tests.push(`size :over ${c.largerThan}`);
  if (c.smallerThan !== null) tests.push(`size :under ${c.smallerThan}`);
  if (!tests.length) return null;

  const a = f.actions;
  const actions: string[] = [];
  const flag = (name: string) => {
    uses.add("imap4flags");
    actions.push(`addflag ${str(name)};`);
  };
  if (a.markRead) flag("\\Seen");
  if (a.star) flag("\\Flagged");
  if (a.label) flag(a.label);
  if (a.forwardTo) {
    uses.add("copy");
    actions.push(`redirect :copy ${str(a.forwardTo)};`);
  }
  const folder = a.delete ? ctx.trash ?? "Trash" : a.moveTo ?? (a.skipInbox ? ctx.archive ?? "Archive" : null);
  if (folder) {
    uses.add("fileinto");
    // Archive is made if the server hasn't one; a chosen folder that's gone isn't
    // brought back, and its mail stays in the inbox.
    const create = !a.delete && !a.moveTo && !ctx.archive;
    if (create) uses.add("mailbox");
    actions.push(`fileinto${create ? " :create" : ""} ${str(folder)};`);
  }
  if (!actions.length) return null;
  const test = tests.length === 1 ? tests[0] : `allof (${tests.join(", ")})`;
  return `if ${test} {\n  ${actions.join("\n  ")}\n}`;
}

function vacationRule(v: Vacation, ctx: SieveContext, uses: Set<string>): string | null {
  if (!v.on || !v.message.trim()) return null;
  uses.add("vacation");
  const zone = v.zone ? ` :zone ${str(v.zone)}` : "";
  const dates: string[] = [];
  if (v.start) dates.push(`currentdate${zone} :value "ge" "date" ${str(v.start)}`);
  if (v.end) dates.push(`currentdate${zone} :value "le" "date" ${str(v.end)}`);
  if (dates.length) {
    uses.add("date");
    uses.add("relational");
  }
  const reply = [
    "vacation :days 4",
    v.subject.trim() ? `:subject ${str(v.subject.trim())}` : "",
    ctx.addresses.length ? `:addresses ${list(ctx.addresses)}` : "",
    str(v.message.replace(/\r\n?/g, "\n")),
  ].filter(Boolean).join(" ");
  if (!dates.length) return `${reply};`;
  return `if ${dates.length === 1 ? dates[0] : `allof (${dates.join(", ")})`} {\n  ${reply};\n}`;
}

const MODEL = "# viauna-model: ";
const HASH = "# viauna-hash: ";
const hash = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/** The whole script for this model. Extensions it uses must be in `available`. */
export function generate(model: SieveModel, ctx: SieveContext): { script: string; uses: Set<string> } {
  const uses = new Set<string>();
  const parts: string[] = [];
  // The vacation responder first, so a reply is sent even for mail a filter moves.
  const vacation = vacationRule(model.vacation, ctx, uses);
  if (vacation) parts.push(`# Vacation responder\n${vacation}`);
  model.filters.forEach((f, i) => {
    const rule = filterRule(f, ctx, uses);
    if (rule) parts.push(`# Filter ${i + 1}\n${rule}`);
  });
  if (model.include.length) {
    uses.add("include");
    for (const name of model.include) parts.push(`# Rules made in another app\ninclude :personal :optional ${str(name)};`);
  }
  const rules = (uses.size ? `require ${list([...uses].sort())};\n\n` : "") + parts.join("\n\n") + "\n";
  const header = [
    "# Viauna's filters and vacation responder: change them in Viauna's settings.",
    "# Viauna rewrites this script each time they're saved there.",
    `${MODEL}${Buffer.from(JSON.stringify(model), "utf8").toString("base64url")}`,
    `${HASH}${hash(rules)}`,
    "",
  ].join("\n");
  return { script: (header + "\n" + rules).replace(/\r?\n/g, "\r\n"), uses };
}

/**
 * The model in a script Viauna wrote, and whether the rules were changed elsewhere
 * since. Null for a script Viauna didn't write.
 */
export function readModel(script: string): { model: unknown; changedElsewhere: boolean } | null {
  const text = script.replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const modelLine = lines.find((l) => l.startsWith(MODEL));
  const hashLine = lines.find((l) => l.startsWith(HASH));
  if (!modelLine) return null;
  let model: unknown = null;
  try {
    model = JSON.parse(Buffer.from(modelLine.slice(MODEL.length).trim(), "base64url").toString("utf8"));
  } catch {
    return null;
  }
  // The rules are everything after the header's blank line.
  const start = text.indexOf("\n\n");
  const rules = start < 0 ? "" : text.slice(start + 2);
  return { model, changedElsewhere: !hashLine || hashLine.slice(HASH.length).trim() !== hash(rules) };
}
