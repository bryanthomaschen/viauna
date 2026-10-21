// Per-mailbox settings, shared by every browser signed in to it. Kept in the state
// store with the account, along with the senders whose images are always shown.
import { EventEmitter } from "node:events";
import { isZone } from "./icalendar.ts";
import { orIgnore, state } from "./state/db.ts";

/** "changed" with the account id, when a mailbox's settings change (for other open tabs). */
export const accountSettingsEvents = new EventEmitter();
accountSettingsEvents.setMaxListeners(1000);

export interface Identity {
  name: string;
  address: string;
}

export interface AccountSettings {
  /** Display name for outgoing mail. */
  name: string;
  /** HTML signature appended to new messages and replies. */
  signature: string;
  /** Extra From addresses ("send mail as"), e.g. aliases the server accepts. */
  aliases: Identity[];
  /** "ask": block remote images until allowed; "always": load them. */
  images: "ask" | "always";
  pageSize: 25 | 50 | 100;
  /** The calendar's time zone (IANA); empty: whichever the browser is in. */
  timeZone: string;
  /** The calendar's first day of the week; "auto" follows the browser's language. */
  weekStart: "auto" | "sunday" | "monday" | "saturday";
  /** How long a new event lasts, in minutes. */
  eventMinutes: 15 | 30 | 45 | 60 | 90 | 120;
}

export const DEFAULT_SETTINGS: AccountSettings = {
  name: "",
  signature: "",
  aliases: [],
  images: "ask",
  pageSize: 50,
  timeZone: "",
  weekStart: "auto",
  eventMinutes: 60,
};

export async function getSettings(accountId: number): Promise<AccountSettings> {
  const row = await state().selectFrom("accounts").select("settings").where("id", "=", accountId).executeTakeFirst();
  let stored: Partial<AccountSettings> = {};
  try {
    stored = JSON.parse(row?.settings ?? "{}");
  } catch {
    stored = {};
  }
  return { ...DEFAULT_SETTINGS, ...stored };
}

const MAX_SIGNATURE = 20_000;

/** Validates and merges a partial update. Returns the new settings or an error. */
export async function updateSettings(accountId: number, patch: Record<string, unknown>): Promise<AccountSettings | { error: string }> {
  const next = await getSettings(accountId);
  if ("name" in patch) next.name = String(patch.name ?? "").slice(0, 200).trim();
  if ("signature" in patch) {
    const sig = String(patch.signature ?? "");
    if (sig.length > MAX_SIGNATURE) return { error: "Signature is too long." };
    next.signature = sig;
  }
  if ("aliases" in patch) {
    if (!Array.isArray(patch.aliases) || patch.aliases.length > 50) return { error: "Invalid aliases." };
    const aliases: Identity[] = [];
    for (const a of patch.aliases as Identity[]) {
      const address = String(a?.address ?? "").trim().toLowerCase();
      if (!/^[^\s@<>]+@[^\s@<>]+$/.test(address)) return { error: `"${address}" isn't an email address.` };
      aliases.push({ name: String(a?.name ?? "").slice(0, 200).trim(), address });
    }
    next.aliases = aliases;
  }
  if ("images" in patch) next.images = patch.images === "always" ? "always" : "ask";
  if ("pageSize" in patch) {
    const size = Number(patch.pageSize);
    next.pageSize = size === 25 || size === 100 ? size : 50;
  }
  if ("timeZone" in patch) {
    const zone = String(patch.timeZone ?? "");
    if (zone && !isZone(zone)) return { error: `"${zone}" isn't a time zone Viauna knows.` };
    next.timeZone = zone;
  }
  if ("weekStart" in patch) {
    const day = String(patch.weekStart);
    next.weekStart = day === "sunday" || day === "monday" || day === "saturday" ? day : "auto";
  }
  if ("eventMinutes" in patch) {
    const minutes = Number(patch.eventMinutes);
    next.eventMinutes = ([15, 30, 45, 60, 90, 120] as const).find((m) => m === minutes) ?? 60;
  }
  await state().updateTable("accounts").set({ settings: JSON.stringify(next) }).where("id", "=", accountId).execute();
  accountSettingsEvents.emit("changed", accountId);
  return next;
}

/** Every address that is "me" for this account: the login address plus aliases. */
export async function myAddresses(accountId: number, email: string): Promise<Set<string>> {
  const s = await getSettings(accountId);
  return new Set([email.toLowerCase(), ...s.aliases.map((a) => a.address.toLowerCase())]);
}

/** Senders whose remote images this account always shows. */
export async function isTrustedSender(accountId: number, address: string): Promise<boolean> {
  const row = await state()
    .selectFrom("trusted_senders")
    .select("address")
    .where("account_id", "=", accountId)
    .where("address", "=", address)
    .executeTakeFirst();
  return !!row;
}

export async function trustSender(accountId: number, address: string) {
  await orIgnore(state().insertInto("trusted_senders").values({ account_id: accountId, address })).execute();
}
