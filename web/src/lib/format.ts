import type { Address, Participant } from "./types";

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** List-view date, as Gmail shows it: "3:42 PM" today, "Oct 3" this year, "3/10/24" before. */
export function listDate(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  if (sameDay(d, now)) return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return d.toLocaleDateString(undefined, { year: "2-digit", month: "numeric", day: "numeric" });
}

/** Conversation-view date: "Oct 3, 2026, 3:42 PM (2 days ago)". */
export function fullDate(ms: number): string {
  const d = new Date(ms);
  const abs = d.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  return `${abs} (${relative(ms)})`;
}

export function relative(ms: number): string {
  const diff = Date.now() - ms;
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const min = Math.round(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return rtf.format(-min, "minute");
  const hours = Math.round(min / 60);
  if (hours < 24) return rtf.format(-hours, "hour");
  const days = Math.round(hours / 24);
  if (days < 30) return rtf.format(-days, "day");
  const months = Math.round(days / 30);
  if (months < 12) return rtf.format(-months, "month");
  return rtf.format(-Math.round(days / 365), "year");
}

export function longDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function displayName(a: Address | undefined): string {
  if (!a) return "";
  return a.name?.trim() || a.address;
}

export function firstName(a: Address | Participant): string {
  const name = ("name" in a && a.name?.trim()) || a.address.split("@")[0];
  if (name === "me") return "me";
  return name.split(/\s+/)[0];
}

export function formatAddress(a: Address): string {
  return a.name ? `${a.name} <${a.address}>` : a.address;
}

/**
 * Gmail's sender column: "Priya, me (5)", or with many people "Hannah … Priya, me (6)".
 * Returns segments so unread names can be bold.
 */
export function participantLine(ps: Participant[], count: number): { parts: { text: string; bold: boolean }[]; count: string } {
  const n = ps.length;
  const short = n > 1;
  const name = (p: Participant) => (p.me ? "me" : short ? firstName(p) : p.name);
  let chosen: (Participant | null)[];
  if (n <= 3) chosen = ps;
  else chosen = [ps[0], null, ps[n - 2], ps[n - 1]];
  const parts: { text: string; bold: boolean }[] = [];
  chosen.forEach((p, i) => {
    if (p === null) {
      parts.push({ text: " .. ", bold: false });
      return;
    }
    if (i > 0 && chosen[i - 1] !== null) parts.push({ text: ", ", bold: false });
    parts.push({ text: name(p), bold: p.unread });
  });
  return { parts, count: count > 1 ? String(count) : "" };
}

const AVATAR_COLORS = ["#1a73e8", "#e8710a", "#188038", "#d93025", "#9334e6", "#007b83", "#c5221f", "#b06000", "#3949ab", "#00897b"];

export function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export function initial(a: Address | undefined): string {
  const s = (a?.name || a?.address || "?").trim();
  const ch = [...s][0] ?? "?";
  return ch.toUpperCase();
}

export function replySubject(subject: string): string {
  return /^\s*re:/i.test(subject) ? subject : `Re: ${subject}`;
}

export function forwardSubject(subject: string): string {
  return /^\s*(fwd?|fw):/i.test(subject) ? subject : `Fwd: ${subject}`;
}

/** Contrasting text colour for a label chip. */
export function textOn(bg: string): string {
  const m = bg.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return "#202124";
  const [r, g, b] = m.slice(1).map((x) => parseInt(x, 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 160 ? "#202124" : "#ffffff";
}
