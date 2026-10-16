// A tiny history router. Viauna's URLs mirror Gmail's structure:
//
//   /u/0/inbox                 the inbox of the first signed-in account
//   /u/0/inbox/123             conversation 123, opened from the inbox
//   /u/0/label/work            a label          /u/0/folder/12   a folder
//   /u/0/search/from%3Aann     search results   /u/0/settings    settings
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

export interface Route {
  name: "login" | "mail" | "settings" | "none";
  account: number;
  folder: Folder;
  thread: number | null;
  page: number;
}

const SIMPLE = new Set(["inbox", "starred", "sent", "drafts", "all", "spam", "trash", "archive"]);

export function parseRoute(path: string): Route {
  const [pathname, search] = path.split("?");
  const page = Math.max(0, Number(new URLSearchParams(search ?? "").get("p") ?? 1) - 1) || 0;
  const parts = pathname.split("/").filter(Boolean);
  const none: Route = { name: "none", account: 0, folder: { kind: "inbox" }, thread: null, page: 0 };
  if (parts[0] === "login") return { ...none, name: "login" };
  if (parts[0] !== "u" || parts.length < 2) return none;
  const account = Number(parts[1]);
  if (!Number.isInteger(account)) return none;
  const rest = parts.slice(2);
  if (rest[0] === "settings") return { ...none, name: "settings", account };
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
  return { name: "mail", account, folder, thread, page };
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
