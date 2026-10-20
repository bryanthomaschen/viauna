// Filters and the vacation responder: read from and saved to the mailbox's own Sieve
// script on its mail server (sieve.ts, over managesieve.ts), signed in as the mailbox.
// They run there as mail arrives, whether anyone has Viauna open or not, and apply in
// every app. Only mailboxes on this server's own mail server have them.
import crypto from "node:crypto";
import { config, onOwnServer, setting } from "./config.ts";
import type { Credentials } from "./crypto.ts";
import type { AccountInfo } from "./imap/runtime.ts";
import { getMailboxes, specialUseName } from "./imap/store.ts";
import { log } from "./log.ts";
import { ManageSieve, SieveError } from "./managesieve.ts";
import { myAddresses } from "./settings.ts";
import { EMPTY_MODEL, EMPTY_VACATION, type Filter, type SieveContext, type SieveModel, type Vacation, generate, readModel } from "./sieve.ts";

export const SCRIPT = "viauna";
const MAX_FILTERS = 200;

export class FilterError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface FiltersState {
  filters: Filter[];
  vacation: Vacation;
  /** Rules made in another app that keep running (their script names). */
  include: string[];
  /** The script was edited outside Viauna since it was last saved here. */
  changedElsewhere: boolean;
  /** What may be used here. */
  features: { filters: boolean; vacation: boolean; forwarding: boolean };
}

/** Why this account can't have filters here, or null if it can. */
export function unavailable(account: AccountInfo): string | null {
  if (!setting("filters") && !setting("vacation")) return "Filters and the vacation responder are turned off on this server.";
  if (!config.managesieve) return "No mail server is set up for filters.";
  if (!onOwnServer(account)) return "Filters are only for mailboxes on this server's own mail server.";
  return null;
}

// ------------------------------------------------------------ checking what was sent

const KEYWORD = /^[^\s(){%*"\\\]]{1,100}$/;
const ADDRESS = /^[^\s@,"]+@[^\s@,"]+$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function text(v: unknown, max: number, what: string): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (s.length > max) throw new FilterError(`${what} is too long.`);
  if (/[\x00-\x1f]/.test(s)) throw new FilterError(`${what} must be on one line.`);
  return s;
}

function size(v: unknown, what: string): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 2 ** 31) throw new FilterError(`${what} must be a whole number of bytes.`);
  return n;
}

/**
 * A filter as the page sent it, checked against the mailbox's folders. With folders
 * null (reading back what the server has), what was allowed when it was saved stays.
 */
export function cleanFilter(input: unknown, folders: Set<string> | null): Filter {
  const o = (input ?? {}) as Record<string, any>;
  const c = (o.criteria ?? {}) as Record<string, unknown>;
  const a = (o.actions ?? {}) as Record<string, unknown>;
  const filter: Filter = {
    id: typeof o.id === "string" && /^[\w-]{1,40}$/.test(o.id) ? o.id : crypto.randomUUID(),
    criteria: {
      from: text(c.from, 500, "From"),
      to: text(c.to, 500, "To"),
      subject: text(c.subject, 500, "Subject"),
      hasWords: text(c.hasWords, 500, "Has the words"),
      doesntHave: text(c.doesntHave, 500, "Doesn't have"),
      hasAttachment: c.hasAttachment === true,
      largerThan: size(c.largerThan, "Larger than"),
      smallerThan: size(c.smallerThan, "Smaller than"),
    },
    actions: {
      skipInbox: a.skipInbox === true,
      markRead: a.markRead === true,
      star: a.star === true,
      label: a.label ? text(a.label, 100, "The label") : null,
      moveTo: a.moveTo ? text(a.moveTo, 500, "The folder") : null,
      delete: a.delete === true,
      forwardTo: a.forwardTo ? text(a.forwardTo, 320, "The forwarding address") : null,
    },
  };
  const { criteria: cr, actions: ac } = filter;
  if (!cr.from && !cr.to && !cr.subject && !cr.hasWords && !cr.doesntHave && !cr.hasAttachment && cr.largerThan === null && cr.smallerThan === null) {
    throw new FilterError("Say which messages the filter is for.");
  }
  if (!ac.skipInbox && !ac.markRead && !ac.star && !ac.label && !ac.moveTo && !ac.delete && !ac.forwardTo) {
    throw new FilterError("Choose what the filter does.");
  }
  if (ac.label && !KEYWORD.test(ac.label)) throw new FilterError("That label can't be used in a filter.");
  if (ac.moveTo && folders && !folders.has(ac.moveTo)) throw new FilterError("That folder doesn't exist.");
  if (ac.forwardTo) {
    if (folders && !setting("filterForwarding")) {
      throw new FilterError("Forwarding in filters is turned off on this server: remove it from the filter to save.");
    }
    if (!ADDRESS.test(ac.forwardTo)) throw new FilterError(`"${ac.forwardTo}" isn't an email address.`);
  }
  return filter;
}

export function cleanVacation(input: unknown): Vacation {
  const o = (input ?? {}) as Record<string, unknown>;
  const day = (v: unknown, what: string) => {
    if (v === null || v === undefined || v === "") return null;
    if (typeof v !== "string" || !DAY.test(v) || Number.isNaN(Date.parse(v))) throw new FilterError(`${what} must be a date.`);
    return v;
  };
  const message = typeof o.message === "string" ? o.message.replace(/\r\n?/g, "\n") : "";
  if (message.length > 10_000) throw new FilterError("The message is too long.");
  const vacation: Vacation = {
    on: o.on === true,
    start: day(o.start, "The first day"),
    end: day(o.end, "The last day"),
    subject: text(o.subject, 200, "The subject"),
    message: message.trim(),
    zone: typeof o.zone === "string" && /^[+-]\d{4}$/.test(o.zone) ? o.zone : null,
  };
  if (vacation.start && vacation.end && vacation.end < vacation.start) throw new FilterError("The last day is before the first.");
  if (vacation.on && !vacation.message) throw new FilterError("Write the message to send.");
  return vacation;
}

/** A model read back from a script; anything that doesn't parse at all is left out. */
function cleanModel(raw: unknown): SieveModel {
  const o = (raw ?? {}) as Record<string, unknown>;
  const filters: Filter[] = [];
  for (const f of Array.isArray(o.filters) ? o.filters : []) {
    try {
      filters.push(cleanFilter(f, null));
    } catch {
      // Not a filter Viauna could have written.
    }
  }
  let vacation = EMPTY_VACATION;
  try {
    vacation = cleanVacation(o.vacation);
  } catch {
    vacation = EMPTY_VACATION;
  }
  const include = Array.isArray(o.include) ? o.include.filter((n): n is string => typeof n === "string" && n !== SCRIPT).slice(0, 5) : [];
  return { filters, vacation, include };
}

// ------------------------------------------------------------ the server

function context(account: AccountInfo, addresses: Set<string>): { ctx: SieveContext; folders: Set<string> } {
  const boxes = getMailboxes(account.id);
  const special = (use: string) => boxes.find((m) => specialUseName(m.special_use) === use)?.path ?? null;
  return {
    ctx: { archive: special("archive"), trash: special("trash"), addresses: [...addresses] },
    folders: new Set(boxes.filter((m) => m.selectable).map((m) => m.path)),
  };
}

async function connect(account: AccountInfo, creds: Credentials): Promise<ManageSieve> {
  const why = unavailable(account);
  if (why) throw new FilterError(why, 404);
  try {
    return await ManageSieve.connect(config.managesieve!, creds);
  } catch (err) {
    log.warn("managesieve connection failed", { account: account.id, error: (err as Error).message });
    throw new FilterError((err as Error).message, 502);
  }
}

/** The current model, and what's active on the server. */
async function current(sieve: ManageSieve) {
  const scripts = await sieve.listScripts();
  const active = scripts.find((s) => s.active)?.name ?? null;
  let model: SieveModel = { ...EMPTY_MODEL };
  let changedElsewhere = false;
  if (scripts.some((s) => s.name === SCRIPT)) {
    const read = readModel(await sieve.getScript(SCRIPT));
    if (read) {
      model = cleanModel(read.model);
      changedElsewhere = read.changedElsewhere;
    } else {
      changedElsewhere = true;
    }
  }
  // Another app's rules, active now, keep running alongside Viauna's.
  if (active && active !== SCRIPT && !model.include.includes(active)) model = { ...model, include: [...model.include, active] };
  return { model, changedElsewhere, active };
}

function state(model: SieveModel, changedElsewhere: boolean): FiltersState {
  return {
    filters: model.filters,
    vacation: model.vacation,
    include: model.include,
    changedElsewhere,
    features: { filters: setting("filters"), vacation: setting("vacation"), forwarding: setting("filterForwarding") },
  };
}

export async function loadFilters(account: AccountInfo, creds: Credentials): Promise<FiltersState> {
  const sieve = await connect(account, creds);
  try {
    const { model, changedElsewhere } = await current(sieve);
    return state(model, changedElsewhere);
  } finally {
    await sieve.logout();
  }
}

/**
 * Changes the model and saves the script: checked by the server first, then made the
 * active one. With nothing left, Viauna's script goes and the rules it included are
 * active again.
 */
export async function saveFilters(account: AccountInfo, creds: Credentials, change: (model: SieveModel, folders: Set<string>) => SieveModel): Promise<FiltersState> {
  const sieve = await connect(account, creds);
  try {
    const { ctx, folders } = context(account, await myAddresses(account.id, account.email));
    const { model: before, active } = await current(sieve);
    const model = change(before, folders);
    if (model.filters.length > MAX_FILTERS) throw new FilterError(`A mailbox can have at most ${MAX_FILTERS} filters.`);
    const empty = !model.filters.length && !model.vacation.on;
    if (empty) {
      if (active === SCRIPT || active === null) await sieve.setActive(model.include[0] ?? "");
      if ((await sieve.listScripts()).some((s) => s.name === SCRIPT)) await sieve.deleteScript(SCRIPT);
      return state({ ...model, include: [] }, false);
    }
    const { script, uses } = generate(model, ctx);
    const missing = [...uses].filter((x) => !sieve.capabilities.extensions.has(x));
    if (missing.length) throw new FilterError(`The mail server can't do that: it lacks the Sieve extension ${missing.join(", ")}.`);
    try {
      await sieve.checkScript(script);
      await sieve.putScript(SCRIPT, script);
      if (active !== SCRIPT) await sieve.setActive(SCRIPT);
    } catch (err) {
      if (err instanceof SieveError) throw new FilterError(`The mail server didn't accept these filters: ${err.message}`, 502);
      throw err;
    }
    log.info("filters saved", { account: account.id, filters: model.filters.length, vacation: model.vacation.on });
    return state(model, false);
  } finally {
    await sieve.logout();
  }
}
