import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive, ArchiveRestore, ChevronDown, ChevronLeft, ChevronRight, EllipsisVertical, FolderInput, Inbox, Mail, MailOpen,
  OctagonAlert, Paperclip, RefreshCw, Search, Star, Tag, Trash2,
} from "lucide-react";
import { type DragEvent, memo, useEffect, useMemo, useRef, useState } from "react";
import { listState, useAccount } from "../lib/account";
import { type ActionRequest, runAction } from "../lib/actions";
import { api } from "../lib/api";
import { openDraft } from "../lib/compose";
import { listDate, participantLine, textOn } from "../lib/format";
import { type Folder, type Route, folderPath, navigate, threadPath, viewParam } from "../lib/router";
import { toast } from "../lib/store";
import type { Label, ThreadSummary } from "../lib/types";
import { IconButton } from "./common";
import { LabelPicker, MovePicker } from "./Pickers";
import { steeringByKeyboard, useViewHandlers } from "./shortcuts";
import { THREAD_DRAG } from "./Sidebar";

export function LabelChip({ label, keyword, onRemove, large }: { label?: Label; keyword: string; onRemove?: () => void; large?: boolean }) {
  const bg = label?.color ?? undefined;
  return (
    <span className={`chip ${large ? "lg" : ""}`} style={bg ? { background: bg, color: textOn(bg) } : undefined}>
      {label?.name ?? keyword}
      {onRemove && (
        <button type="button" aria-label={`Remove label ${label?.name ?? keyword}`} onClick={(e) => { e.stopPropagation(); onRemove(); }}>
          ×
        </button>
      )}
    </span>
  );
}

/** What the list's actions mean in this folder. */
function folderCaps(folder: Folder, specialKind: string | null) {
  const kind = folder.kind === "folder" ? specialKind ?? "folder" : folder.kind;
  return {
    archive: kind !== "archive" && kind !== "trash" && kind !== "spam" && kind !== "sent" && kind !== "drafts",
    toInbox: kind === "archive" || kind === "folder" || kind === "trash",
    spam: kind !== "spam" && kind !== "trash" && kind !== "drafts" && kind !== "sent",
    notSpam: kind === "spam",
    deleteForever: kind === "trash" || kind === "spam",
  };
}

interface RowProps {
  t: ThreadSummary;
  folder: Folder;
  selected: boolean;
  focused: boolean;
  labels: Map<string, Label>;
  inboxId: number | undefined;
  onOpen: (t: ThreadSummary) => void;
  onSelect: (id: number, shift: boolean) => void;
  onAction: (req: ActionRequest) => void;
  onDragStart: (e: DragEvent, id: number) => void;
}

const Row = memo(function Row({ t, folder, selected, focused, labels, inboxId, onOpen, onSelect, onAction, onDragStart }: RowProps) {
  const { parts, count } = participantLine(t.participants, t.count);
  const sentView = folder.kind === "sent";
  const showInbox = (folder.kind === "search" || folder.kind === "all" || folder.kind === "starred" || folder.kind === "label") && inboxId !== undefined && t.mailboxIds.includes(inboxId);
  const caps = folderCaps(folder, null);
  return (
    <div
      className={`row ${t.unread ? "unread" : ""} ${selected ? "selected" : ""} ${focused ? "focused" : ""}`}
      role="row"
      aria-selected={selected}
      draggable
      onDragStart={(e) => onDragStart(e, t.id)}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button, input")) return;
        onOpen(t);
      }}
    >
      <div className="cells-left">
        <div className="cell-check">
          <input type="checkbox" className="checkbox" checked={selected} aria-label="Select conversation"
            onChange={() => {}} onClick={(e) => onSelect(t.id, e.shiftKey)} />
        </div>
        <div className="cell-star">
          <button type="button" className={`star-btn ${t.starred ? "on" : ""}`} aria-label={t.starred ? "Starred" : "Not starred"} aria-pressed={t.starred}
            onClick={() => onAction({ action: t.starred ? "unstar" : "star", threads: [t.id] })}>
            <Star size={18} fill={t.starred ? "currentColor" : "none"} />
          </button>
        </div>
      </div>
      <div className="sender">
        {sentView && t.recipients.length ? (
          <span>To: {t.recipients.slice(0, 3).join(", ")}</span>
        ) : (
          parts.map((p, i) => (p.bold ? <b key={i}>{p.text}</b> : <span key={i} style={t.unread ? { fontWeight: 400 } : undefined}>{p.text}</span>))
        )}
        {t.drafts > 0 && <span className="draft">{parts.length ? ", " : ""}Draft{t.drafts > 1 ? `s (${t.drafts})` : ""}</span>}
        {count && <span className="count">{count}</span>}
      </div>
      <div className="summary">
        {showInbox && <span className="chip">Inbox</span>}
        {t.labels.map((k) => (
          <LabelChip key={k} keyword={k} label={labels.get(k)} />
        ))}
        <span className="subject">{t.subject || "(no subject)"}</span>
        {t.snippet && <span className="snippet">{t.snippet}</span>}
      </div>
      <div className="meta">
        {t.attachments && <Paperclip size={16} className="attach-icon" aria-label="Has attachment" />}
        <span className="date" title={new Date(t.date).toLocaleString()}>{listDate(t.date)}</span>
      </div>
      <div className="hover-actions">
        {caps.archive && (
          <IconButton label="Archive" size="sm" onClick={() => onAction({ action: "archive", threads: [t.id] })}><Archive size={18} /></IconButton>
        )}
        {caps.notSpam && (
          <IconButton label="Not spam" size="sm" onClick={() => onAction({ action: "notspam", threads: [t.id] })}><Inbox size={18} /></IconButton>
        )}
        {caps.deleteForever ? (
          <IconButton label="Delete forever" size="sm" onClick={() => onAction({ action: "delete", threads: [t.id] })}><Trash2 size={18} /></IconButton>
        ) : (
          <IconButton label="Delete" size="sm" onClick={() => onAction({ action: "trash", threads: [t.id] })}><Trash2 size={18} /></IconButton>
        )}
        {t.unread ? (
          <IconButton label="Mark as read" size="sm" onClick={() => onAction({ action: "read", threads: [t.id] })}><MailOpen size={18} /></IconButton>
        ) : (
          <IconButton label="Mark as unread" size="sm" onClick={() => onAction({ action: "unread", threads: [t.id] })}><Mail size={18} /></IconButton>
        )}
      </div>
    </div>
  );
});

const NO_THREADS: ThreadSummary[] = [];

const EMPTY: Record<string, [string, string]> = {
  inbox: ["Your inbox is empty", "Mail that arrives will show up here."],
  starred: ["No starred messages", "Stars let you give messages a special status to make them easier to find."],
  sent: ["No sent messages", "Send a message and it will appear here."],
  drafts: ["You don't have any saved drafts", "Saving a draft allows you to keep a message you aren't ready to send yet."],
  spam: ["Hooray, no spam here!", ""],
  trash: ["No conversations in Trash", ""],
  all: ["No mail", ""],
  archive: ["Nothing archived yet", "Archiving moves a conversation out of your inbox without deleting it."],
  label: ["There are no conversations with this label", ""],
  folder: ["This folder is empty", ""],
  search: ["No messages matched your search", "Try different words, or search options like from: or has:attachment."],
};

export function ThreadList({ route }: { route: Route }) {
  const acct = useAccount();
  const client = useQueryClient();
  const folder = route.folder;
  const view = viewParam(folder);
  const q = folder.kind === "search" ? folder.query : "";
  const key = `${acct.index}:${folderPath(acct.index, folder)}:${route.page}`;
  const query = useQuery({
    queryKey: ["threads", acct.index, view, q, route.page],
    queryFn: () => api.threads(acct.index, view === "search" ? "all" : view, route.page, q || undefined),
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[2] === view && prevQuery?.queryKey[3] === q ? prev : undefined),
    refetchInterval: acct.ready ? false : 2000,
  });
  const data = query.data;
  const threads = data?.threads ?? NO_THREADS;
  const { cursor, selected } = listState.use();
  const lastClicked = useRef<number | null>(null);
  const [menu, setMenu] = useState<"label" | "move" | null>(null);

  useEffect(() => {
    listState.set((s) => (s.key === key ? s : { key, ids: [], cursor: 0, selected: new Set(), total: 0, offset: 0 }));
  }, [key]);
  useEffect(() => {
    listState.set((s) => ({
      ...s,
      ids: threads.map((t) => t.id),
      cursor: Math.min(s.cursor, Math.max(0, threads.length - 1)),
      total: data?.total ?? 0,
      offset: (data?.page ?? 0) * (data?.size ?? 50),
    }));
  }, [threads, data]);
  useEffect(() => {
    document.querySelector(".row.focused")?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const mailbox = folder.kind === "folder" ? acct.mailboxById.get(folder.id) : null;
  const caps = folderCaps(folder, mailbox?.specialUse ?? null);
  const sel = [...selected].filter((id) => threads.some((t) => t.id === id));
  const targets = sel.length ? sel : threads[cursor] ? [threads[cursor].id] : [];
  const selectedThreads = threads.filter((t) => sel.includes(t.id));
  const allRead = selectedThreads.every((t) => !t.unread);

  const act = (req: ActionRequest) => {
    void runAction(client, acct.index, folder, req);
    if (req.threads && ["archive", "trash", "delete", "spam", "notspam", "move", "inbox"].includes(req.action)) {
      listState.set((s) => ({ ...s, selected: new Set([...s.selected].filter((id) => !req.threads!.includes(id))) }));
    }
  };

  const open = async (t: ThreadSummary) => {
    if (folder.kind === "drafts" && t.drafts === t.count) {
      try {
        const conv = await api.thread(acct.index, t.id, "drafts");
        const d = conv.messages.find((m) => m.draft) ?? conv.messages[conv.messages.length - 1];
        await openDraft(acct.index, { mailboxId: d.mailboxId, uid: d.uid }, acct.identities);
      } catch (err) {
        toast((err as Error).message, { error: true });
      }
      return;
    }
    listState.set((s) => ({ ...s, cursor: Math.max(0, threads.findIndex((x) => x.id === t.id)) }));
    navigate(threadPath(acct.index, folder, t.id) + (route.page ? `?p=${route.page + 1}` : ""));
  };

  const toggleSelect = (id: number, shift: boolean) => {
    listState.set((s) => {
      const next = new Set(s.selected);
      const ids = threads.map((t) => t.id);
      if (shift && lastClicked.current !== null) {
        const [a, b] = [ids.indexOf(lastClicked.current), ids.indexOf(id)].sort((x, y) => x - y);
        const on = !s.selected.has(id);
        for (const x of ids.slice(a, b + 1)) on ? next.add(x) : next.delete(x);
      } else if (next.has(id)) next.delete(id);
      else next.add(id);
      lastClicked.current = id;
      return { ...s, selected: next };
    });
  };

  const selectBy = (pred: (t: ThreadSummary) => boolean) =>
    listState.set((s) => ({ ...s, selected: new Set(threads.filter(pred).map((t) => t.id)) }));

  const labelState = useMemo(() => {
    const m = new Map<string, "all" | "some">();
    const pool = selectedThreads.length ? selectedThreads : threads[cursor] ? [threads[cursor]] : [];
    for (const l of acct.labels) {
      const n = pool.filter((t) => t.labels.includes(l.keyword)).length;
      if (n && n === pool.length) m.set(l.keyword, "all");
      else if (n) m.set(l.keyword, "some");
    }
    return m;
  }, [selectedThreads, threads, cursor, acct.labels]);

  const onDragStart = (e: DragEvent, id: number) => {
    const ids = selected.has(id) ? [...selected] : [id];
    e.dataTransfer.setData(THREAD_DRAG, JSON.stringify(ids));
    e.dataTransfer.effectAllowed = "move";
    const ghost = document.createElement("div");
    ghost.textContent = ids.length === 1 ? "Move 1 conversation" : `Move ${ids.length} conversations`;
    Object.assign(ghost.style, { position: "fixed", top: "-100px", padding: "8px 14px", background: "#0b57d0", color: "#fff", borderRadius: "8px", font: "500 14px Roboto, sans-serif" });
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, 10, 10);
    setTimeout(() => ghost.remove(), 0);
  };

  const pick = (which: "label" | "move") => {
    if (!sel.length && threads[cursor]) toggleSelect(threads[cursor].id, false);
    if (targets.length) setMenu(which);
  };

  // The command menu acts on the selection, or on the row under the cursor while it's
  // showing; with neither, it offers no conversation commands rather than guess.
  const commands = () => {
    const ids = sel.length ? sel : steeringByKeyboard() && threads[cursor] ? [threads[cursor].id] : [];
    if (!ids.length) return null;
    const chosen = threads.filter((t) => ids.includes(t.id));
    const starred = chosen.every((t) => t.starred);
    const read = chosen.every((t) => !t.unread);
    const pickFor = (which: "label" | "move") => {
      if (!sel.length) listState.set((s) => ({ ...s, selected: new Set(ids) }));
      setMenu(which);
    };
    return {
      target: ids.length === 1 ? chosen[0]?.subject || "(no subject)" : `${ids.length} conversations`,
      items: [
        ...(caps.archive ? [{ label: "Archive", icon: Archive, key: "e", run: () => act({ action: "archive", threads: ids }) }] : []),
        ...(caps.toInbox ? [{ label: "Move to Inbox", icon: ArchiveRestore, run: () => act({ action: "inbox", threads: ids }) }] : []),
        { label: caps.deleteForever ? "Delete forever" : "Delete", icon: Trash2, key: "#", run: () => act({ action: caps.deleteForever ? "delete" : "trash", threads: ids }) },
        ...(caps.spam ? [{ label: "Report spam", icon: OctagonAlert, key: "!", run: () => act({ action: "spam", threads: ids }) }] : []),
        ...(caps.notSpam ? [{ label: "Not spam", icon: Inbox, key: "!", run: () => act({ action: "notspam", threads: ids }) }] : []),
        read
          ? { label: "Mark as unread", icon: Mail, key: "Shift + u", run: () => act({ action: "unread", threads: ids }) }
          : { label: "Mark as read", icon: MailOpen, key: "Shift + i", run: () => act({ action: "read", threads: ids }) },
        { label: starred ? "Remove star" : "Add star", icon: Star, key: "s", run: () => act({ action: starred ? "unstar" : "star", threads: ids }) },
        { label: "Label as…", icon: Tag, key: "l", run: () => pickFor("label") },
        { label: "Move to…", icon: FolderInput, key: "v", run: () => pickFor("move") },
      ],
    };
  };

  useViewHandlers({
    next: () => listState.set((s) => ({ ...s, cursor: Math.min(s.cursor + 1, threads.length - 1) })),
    prev: () => listState.set((s) => ({ ...s, cursor: Math.max(s.cursor - 1, 0) })),
    open: () => threads[cursor] && void open(threads[cursor]),
    select: () => threads[cursor] && toggleSelect(threads[cursor].id, false),
    archive: () => targets.length && caps.archive && act({ action: "archive", threads: targets }),
    trash: () => targets.length && act({ action: caps.deleteForever ? "delete" : "trash", threads: targets }),
    spam: () => targets.length && act({ action: caps.notSpam ? "notspam" : "spam", threads: targets }),
    star: () => {
      const t = threads[cursor];
      if (t) act({ action: t.starred ? "unstar" : "star", threads: [t.id] });
    },
    read: () => targets.length && act({ action: "read", threads: targets }),
    unread: () => targets.length && act({ action: "unread", threads: targets }),
    // The pickers are in the selection's toolbar: with nothing selected, the row under
    // the cursor is selected first, so the toolbar (and the picker) appear.
    label: () => pick("label"),
    move: () => pick("move"),
    escape: () => listState.set((s) => ({ ...s, selected: new Set() })),
    commands,
  });

  const total = data?.total ?? 0;
  const size = data?.size ?? 50;
  const start = route.page * size;
  const base = folderPath(acct.index, folder);
  const page = (p: number) => navigate(p ? `${base}?p=${p + 1}` : base);
  const allSelected = threads.length > 0 && sel.length === threads.length;
  const mbForSync = folder.kind === "folder" ? mailbox : folder.kind === "inbox" ? acct.special.inbox : null;
  const empty = EMPTY[folder.kind] ?? EMPTY.folder;

  return (
    <>
      <div className="toolbar" role="toolbar" aria-label="Conversation actions">
        <div className="select-all">
          <IconButton label="Select" size="sm" onClick={() => (sel.length ? selectBy(() => false) : selectBy(() => true))}>
            <input type="checkbox" className="checkbox" readOnly tabIndex={-1} aria-hidden checked={allSelected}
              ref={(el) => { if (el) el.indeterminate = sel.length > 0 && !allSelected; }} />
          </IconButton>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button type="button" className="icon-btn xs" aria-label="Select options"><ChevronDown size={16} /></button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="menu" align="start" sideOffset={4}>
                {([
                  ["All", () => true],
                  ["None", () => false],
                  ["Read", (t: ThreadSummary) => !t.unread],
                  ["Unread", (t: ThreadSummary) => t.unread],
                  ["Starred", (t: ThreadSummary) => t.starred],
                  ["Unstarred", (t: ThreadSummary) => !t.starred],
                ] as [string, (t: ThreadSummary) => boolean][]).map(([name, pred]) => (
                  <DropdownMenu.Item key={name} className="menu-item" onSelect={() => selectBy(pred)}>{name}</DropdownMenu.Item>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
        {sel.length === 0 ? (
          <>
            <IconButton label="Refresh" onClick={() => {
              void client.invalidateQueries({ queryKey: ["threads", acct.index] });
              void client.invalidateQueries({ queryKey: ["mailboxes", acct.index] });
            }}>
              <RefreshCw size={18} className={query.isFetching ? "spin-slow" : ""} />
            </IconButton>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <IconButton label="More"><EllipsisVertical size={18} /></IconButton>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content className="menu" align="start" sideOffset={4}>
                  <DropdownMenu.Item className="menu-item" disabled={!threads.some((t) => t.unread)}
                    onSelect={() => act({ action: "read", threads: threads.filter((t) => t.unread).map((t) => t.id) })}>
                    <MailOpen size={18} /> Mark all as read
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </>
        ) : (
          <>
            {caps.archive && <IconButton label="Archive" onClick={() => act({ action: "archive", threads: sel })}><Archive size={18} /></IconButton>}
            {caps.toInbox && <IconButton label="Move to Inbox" onClick={() => act({ action: "inbox", threads: sel })}><ArchiveRestore size={18} /></IconButton>}
            {caps.spam && <IconButton label="Report spam" onClick={() => act({ action: "spam", threads: sel })}><OctagonAlert size={18} /></IconButton>}
            {caps.notSpam && <IconButton label="Not spam" onClick={() => act({ action: "notspam", threads: sel })}><Inbox size={18} /></IconButton>}
            <IconButton label={caps.deleteForever ? "Delete forever" : "Delete"} onClick={() => act({ action: caps.deleteForever ? "delete" : "trash", threads: sel })}>
              <Trash2 size={18} />
            </IconButton>
            <span className="divider" />
            {allRead ? (
              <IconButton label="Mark as unread" onClick={() => act({ action: "unread", threads: sel })}><Mail size={18} /></IconButton>
            ) : (
              <IconButton label="Mark as read" onClick={() => act({ action: "read", threads: sel })}><MailOpen size={18} /></IconButton>
            )}
            <MovePicker
              open={menu === "move"}
              onOpenChange={(o) => setMenu(o ? "move" : null)}
              exclude={folder.kind === "folder" ? folder.id : undefined}
              trigger={<IconButton label="Move to"><FolderInput size={18} /></IconButton>}
              onPick={(mb) => { setMenu(null); act({ action: "move", threads: sel, target: mb.id }); }}
            />
            <LabelPicker
              open={menu === "label"}
              onOpenChange={(o) => setMenu(o ? "label" : null)}
              applied={labelState}
              trigger={<IconButton label="Labels"><Tag size={18} /></IconButton>}
              onToggle={(keyword, add) => act({ action: add ? "label" : "unlabel", threads: sel, keyword })}
            />
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <IconButton label="More"><EllipsisVertical size={18} /></IconButton>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content className="menu" align="start" sideOffset={4}>
                  <DropdownMenu.Item className="menu-item" onSelect={() => act({ action: "star", threads: sel })}><Star size={18} /> Add star</DropdownMenu.Item>
                  <DropdownMenu.Item className="menu-item" onSelect={() => act({ action: "unstar", threads: sel })}><Star size={18} /> Remove star</DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </>
        )}
        <span className="grow" />
        {total > 0 && (
          <span className="range">
            {start + 1}–{Math.min(start + threads.length, total)} of {total.toLocaleString()}
          </span>
        )}
        <IconButton label="Newer" disabled={route.page === 0} onClick={() => page(route.page - 1)}><ChevronLeft size={18} /></IconButton>
        <IconButton label="Older" disabled={start + size >= total} onClick={() => page(route.page + 1)}><ChevronRight size={18} /></IconButton>
      </div>

      {!acct.ready ? (
        <div className="sync-banner"><span className="spinner" /> Setting up your mailbox — fetching your most recent mail…</div>
      ) : mbForSync?.syncing ? (
        <div className="sync-banner">
          <span className="spinner" /> Fetching older mail ({mbForSync.indexed.toLocaleString()} of {mbForSync.total.toLocaleString()})…
        </div>
      ) : null}
      {acct.syncError && <div className="sync-banner">Can't reach the mail server right now ({acct.syncError}). Retrying…</div>}

      <div className="list" role="grid" aria-label="Conversations" aria-busy={query.isFetching}>
        {query.isPending ? (
          <div className="empty"><div className="spinner lg" /></div>
        ) : query.isError ? (
          <div className="empty">
            <h3>Couldn't load this view</h3>
            <p>{(query.error as Error).message}</p>
            <button type="button" className="btn btn-outline" onClick={() => void query.refetch()}>Try again</button>
          </div>
        ) : threads.length === 0 ? (
          <div className="empty">
            <div>
              {folder.kind === "search" ? <Search size={48} /> : <Inbox size={48} />}
              <h3>{empty[0]}</h3>
              {empty[1] && <p>{empty[1]}</p>}
            </div>
          </div>
        ) : (
          <>
            {threads.map((t, i) => (
              <Row
                key={t.id}
                t={t}
                folder={folder}
                selected={selected.has(t.id)}
                focused={i === cursor}
                labels={acct.labelByKeyword}
                inboxId={acct.special.inbox?.id}
                onOpen={(x) => void open(x)}
                onSelect={toggleSelect}
                onAction={act}
                onDragStart={onDragStart}
              />
            ))}
            {start + threads.length >= total && total > 0 && (
              <div className="list-footer">
                {folder.kind === "search" ? "That's everything that matched." : `${total.toLocaleString()} conversation${total === 1 ? "" : "s"}`}
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
