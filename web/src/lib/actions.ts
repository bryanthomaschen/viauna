// Every list/conversation action goes through here: update the cached lists at once
// (so the UI responds instantly), call the server, then offer Undo like Gmail does.
import type { QueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { type Folder, viewParam } from "./router";
import { toast } from "./store";
import type { ActionName, MessageRef, ThreadsResponse } from "./types";

export interface ActionRequest {
  action: ActionName;
  threads?: number[];
  messages?: MessageRef[];
  target?: number;
  keyword?: string;
}

const REMOVES: Record<string, (folder: Folder) => boolean> = {
  archive: (f) => f.kind === "inbox",
  trash: (f) => f.kind !== "trash",
  delete: () => true,
  spam: (f) => f.kind !== "spam",
  notspam: (f) => f.kind === "spam",
  inbox: (f) => f.kind !== "inbox" && f.kind !== "starred" && f.kind !== "all" && f.kind !== "label" && f.kind !== "search",
  move: (f) => f.kind === "inbox" || f.kind === "folder" || f.kind === "archive" || f.kind === "spam" || f.kind === "trash",
  unstar: (f) => f.kind === "starred",
};

const MESSAGES: Partial<Record<ActionName, (n: number) => string>> = {
  archive: (n) => (n === 1 ? "Conversation archived." : `${n} conversations archived.`),
  trash: (n) => (n === 1 ? "Conversation moved to Trash." : `${n} conversations moved to Trash.`),
  delete: (n) => (n === 1 ? "Conversation deleted forever." : `${n} conversations deleted forever.`),
  spam: (n) => (n === 1 ? "Conversation marked as spam." : `${n} conversations marked as spam.`),
  notspam: (n) => (n === 1 ? "Conversation moved to Inbox." : `${n} conversations moved to Inbox.`),
  inbox: (n) => (n === 1 ? "Conversation moved to Inbox." : `${n} conversations moved to Inbox.`),
  move: (n) => (n === 1 ? "Conversation moved." : `${n} conversations moved.`),
  read: (n) => (n === 1 ? "Conversation marked as read." : `${n} conversations marked as read.`),
  unread: (n) => (n === 1 ? "Conversation marked as unread." : `${n} conversations marked as unread.`),
  label: () => "Label applied.",
  unlabel: () => "Label removed.",
};

let lastUndo: (() => void) | null = null;

/** Gmail's "z": undo the last action. */
export function undoLast() {
  lastUndo?.();
}

function patchLists(client: QueryClient, account: number, folder: Folder, req: ActionRequest) {
  const ids = new Set(req.threads ?? []);
  if (!ids.size) return;
  const removes = REMOVES[req.action]?.(folder) ?? false;
  client.setQueriesData<ThreadsResponse>({ queryKey: ["threads", account] }, (data) => {
    if (!data) return data;
    if (removes) {
      const kept = data.threads.filter((t) => !ids.has(t.id));
      return { ...data, threads: kept, total: data.total - (data.threads.length - kept.length) };
    }
    return {
      ...data,
      threads: data.threads.map((t) => {
        if (!ids.has(t.id)) return t;
        switch (req.action) {
          case "read": return { ...t, unread: false, participants: t.participants.map((p) => ({ ...p, unread: false })) };
          case "unread": return { ...t, unread: true };
          case "star": return { ...t, starred: true };
          case "unstar": return { ...t, starred: false };
          case "label": return { ...t, labels: [...new Set([...t.labels, req.keyword!])] };
          case "unlabel": return { ...t, labels: t.labels.filter((l) => l !== req.keyword) };
          default: return t;
        }
      }),
    };
  });
}

export async function runAction(
  client: QueryClient,
  account: number,
  folder: Folder,
  req: ActionRequest,
  opts: { quiet?: boolean } = {},
): Promise<boolean> {
  patchLists(client, account, folder, req);
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["threads", account] });
    void client.invalidateQueries({ queryKey: ["mailboxes", account] });
    void client.invalidateQueries({ queryKey: ["thread", account] });
  };
  try {
    const res = await api.action(account, { ...req, view: viewParam(folder) === "search" ? "all" : viewParam(folder) });
    refresh();
    const n = req.threads?.length ?? 1;
    const text = MESSAGES[req.action]?.(n);
    if (res.undo) {
      const token = res.undo;
      const doUndo = async () => {
        lastUndo = null;
        try {
          await api.undo(account, token);
          toast("Action undone.");
        } catch (err) {
          toast((err as Error).message, { error: true });
        }
        refresh();
      };
      lastUndo = () => void doUndo();
      if (text && !opts.quiet) toast(text, { action: { label: "Undo", run: () => void doUndo() } });
    } else if (text && !opts.quiet && req.action === "delete") {
      toast(text);
    }
    return true;
  } catch (err) {
    refresh();
    toast((err as Error).message, { error: true });
    return false;
  }
}
