import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Popover from "@radix-ui/react-popover";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive, ArchiveRestore, ArrowLeft, ChevronDown, ChevronLeft, ChevronRight, Download, EllipsisVertical, ExternalLink,
  FileText, FolderInput, Forward, Inbox, ListFilter, Mail, OctagonAlert, Paperclip, Reply, ReplyAll, Star, Tag, Trash2, UserPlus,
} from "lucide-react";
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { listState, ui, useAccount } from "../lib/account";
import { type ActionRequest, runAction } from "../lib/actions";
import { api } from "../lib/api";
import { useConfig } from "../lib/config";
import { composes, openCompose, openDraft, startForward, startReply } from "../lib/compose";
import { displayName, fileSize, fullDate, listDate } from "../lib/format";
import { type Route, folderPath, navigate, threadPath, viewParam } from "../lib/router";
import { toast } from "../lib/store";
import type { Address, AttachmentInfo, Conversation, MessageMeta, MessageRef } from "../lib/types";
import { Avatar, IconButton } from "./common";
import { EmailFrame } from "./EmailFrame";
import { LabelPicker, MovePicker } from "./Pickers";
import { useViewHandlers } from "./shortcuts";
import { LabelChip } from "./ThreadList";

const keyOf = (m: MessageMeta) => `${m.mailboxId}:${m.uid}`;
const InlineCompose = lazy(() => import("./Compose").then((m) => ({ default: m.InlineCompose })));

/** Opens the sender's contact if there is one, or a new one filled in from the message. */
async function addToContacts(account: number, person: Address) {
  try {
    const { id } = await api.contactWithAddress(account, person.address);
    if (id !== null) {
      toast(`${displayName(person)} is already in your contacts.`);
      return ui.set((s) => ({ ...s, contactDialog: { id } }));
    }
  } catch (err) {
    return toast((err as Error).message, { error: true });
  }
  const [firstName = "", ...rest] = (person.name ?? "").trim().split(/\s+/);
  ui.set((s) => ({ ...s, contactDialog: { initial: { firstName, lastName: rest.join(" "), emails: [{ address: person.address, label: "" }] } } }));
}

export function ConversationView({ route }: { route: Route }) {
  const acct = useAccount();
  const client = useQueryClient();
  const folder = route.folder;
  const threadId = route.thread!;
  const view = viewParam(folder);
  const query = useQuery({ queryKey: ["thread", acct.index, threadId, view], queryFn: () => api.thread(acct.index, threadId, view) });
  const conv = query.data;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [focusIdx, setFocusIdx] = useState(-1);
  const [menu, setMenu] = useState<"label" | "move" | null>(null);
  const initialised = useRef(false);
  const markedRead = useRef(false);
  const inline = composes.use((list) => list.find((c) => c.placement === "inline" && c.threadId === threadId && !c.hidden));
  const { ids, total, offset } = listState.use();
  const idx = ids.indexOf(threadId);
  const listUrl = folderPath(acct.index, folder) + (route.page ? `?p=${route.page + 1}` : "");

  // Messages that arrive while the conversation is open (your own reply, say) open up.
  const known = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!conv) return;
    const keys = conv.messages.map(keyOf);
    if (known.current) {
      const fresh = keys.filter((k) => !known.current!.has(k));
      if (fresh.length) setExpanded((s) => new Set([...s, ...fresh]));
    }
    known.current = new Set(keys);
  }, [conv]);

  // Gmail opens unread messages and the latest one.
  useEffect(() => {
    if (!conv || initialised.current) return;
    initialised.current = true;
    const open = new Set<string>();
    conv.messages.forEach((m, i) => {
      if (!m.seen || i === conv.messages.length - 1) open.add(keyOf(m));
    });
    setExpanded(open);
    setFocusIdx(conv.messages.length - 1);
  }, [conv]);

  useEffect(() => {
    if (!conv || markedRead.current) return;
    markedRead.current = true;
    const unread = conv.messages.filter((m) => !m.seen && !m.draft).map((m) => ({ mailboxId: m.mailboxId, uid: m.uid }));
    if (unread.length) {
      void runAction(client, acct.index, folder, { action: "read", messages: unread, threads: [threadId] }, { quiet: true });
    }
  }, [conv, client, acct.index, folder, threadId]);

  useEffect(() => {
    if (query.isError) toast((query.error as Error).message, { error: true });
  }, [query.isError, query.error]);

  const back = () => navigate(listUrl);
  const act = async (req: Omit<ActionRequest, "threads">, leave: boolean) => {
    const ok = await runAction(client, acct.index, folder, { ...req, threads: [threadId] });
    if (ok && leave) back();
  };
  const go = (delta: number) => {
    const id = ids[idx + delta];
    if (id !== undefined) {
      listState.set((s) => ({ ...s, cursor: idx + delta }));
      navigate(threadPath(acct.index, folder, id) + (route.page ? `?p=${route.page + 1}` : ""));
    }
  };

  const messages = conv?.messages ?? [];
  const lastReal = [...messages].reverse().find((m) => !m.draft) ?? messages[messages.length - 1];
  const inInbox = !!acct.special.inbox && messages.some((m) => m.mailboxIds.includes(acct.special.inbox!.id));
  const inTrash = folder.kind === "trash";
  const inSpam = folder.kind === "spam";
  const signature = acct.settings?.signature ?? "";

  const reply = (m: MessageMeta | undefined, mode: "reply" | "replyAll" | "forward") => {
    if (!conv || !m) return;
    if (mode === "forward") void startForward(acct.index, conv, m, acct.identities, signature);
    else startReply(acct.index, conv, m, mode, acct.identities, signature);
    setTimeout(() => document.querySelector(".inline-compose")?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 50);
  };

  const labelState = useMemo(() => new Map((conv?.labels ?? []).map((k) => [k, "all" as const])), [conv?.labels]);

  // n / p: a message folded into "N more" unfolds them all, so the one focused is seen.
  const focusMessage = (i: number) => {
    if (i < 0) return;
    if (!showAll && messages.length > 4 && i > 0 && i < messages.length - 2) setShowAll(true);
    setFocusIdx(i);
  };

  useViewHandlers({
    back,
    next: () => go(1),
    prev: () => go(-1),
    archive: () => inInbox && void act({ action: "archive" }, true),
    trash: () => void act({ action: inTrash ? "delete" : "trash" }, true),
    spam: () => void act({ action: inSpam ? "notspam" : "spam" }, true),
    star: () => {
      const starred = messages.some((m) => m.flagged);
      void act({ action: starred ? "unstar" : "star" }, false);
    },
    unread: () => void act({ action: "unread" }, true),
    label: () => setMenu("label"),
    move: () => setMenu("move"),
    reply: () => reply(lastReal, "reply"),
    replyAll: () => reply(lastReal, "replyAll"),
    forward: () => reply(lastReal, "forward"),
    read: () => void act({ action: "read" }, false),
    nextMessage: () => focusMessage(Math.min(focusIdx + 1, messages.length - 1)),
    prevMessage: () => focusMessage(Math.max(focusIdx - 1, 0)),
    open: () => {
      const m = messages[focusIdx];
      if (m) setExpanded((s) => { const n = new Set(s); n.has(keyOf(m)) ? n.delete(keyOf(m)) : n.add(keyOf(m)); return n; });
    },
    escape: back,
    commands: () =>
      conv
        ? {
            target: conv.subject || "(no subject)",
            items: [
              { label: "Reply", icon: Reply, key: "r", run: () => reply(lastReal, "reply") },
              { label: "Reply all", icon: ReplyAll, key: "a", run: () => reply(lastReal, "replyAll") },
              { label: "Forward", icon: Forward, key: "f", run: () => reply(lastReal, "forward") },
              ...(inInbox ? [{ label: "Archive", icon: Archive, key: "e", run: () => void act({ action: "archive" }, true) }] : []),
              { label: inTrash ? "Delete forever" : "Delete", icon: Trash2, key: "#", run: () => void act({ action: inTrash ? "delete" : "trash" }, true) },
              inSpam
                ? { label: "Not spam", icon: Inbox, key: "!", run: () => void act({ action: "notspam" }, true) }
                : { label: "Report spam", icon: OctagonAlert, key: "!", run: () => void act({ action: "spam" }, true) },
              messages.some((m) => m.flagged)
                ? { label: "Remove star", icon: Star, key: "s", run: () => void act({ action: "unstar" }, false) }
                : { label: "Add star", icon: Star, key: "s", run: () => void act({ action: "star" }, false) },
              { label: "Mark as unread", icon: Mail, key: "Shift + u", run: () => void act({ action: "unread" }, true) },
              { label: "Label as…", icon: Tag, key: "l", run: () => setMenu("label") },
              { label: "Move to…", icon: FolderInput, key: "v", run: () => setMenu("move") },
              { label: "Back to the list", icon: ArrowLeft, key: "u", run: back },
            ],
          }
        : null,
  });

  // Long conversations: first message, "N more", and the last two (plus anything open).
  const visible: (MessageMeta | { more: number })[] = [];
  if (!showAll && messages.length > 4) {
    const middle = messages.slice(1, -2);
    const hidden = middle.filter((m) => !expanded.has(keyOf(m)));
    if (hidden.length >= 2) {
      visible.push(messages[0]);
      let pushedMore = false;
      for (const m of middle) {
        if (expanded.has(keyOf(m))) visible.push(m);
        else if (!pushedMore) {
          visible.push({ more: hidden.length });
          pushedMore = true;
        }
      }
      visible.push(...messages.slice(-2));
    } else visible.push(...messages);
  } else visible.push(...messages);

  return (
    <>
      <div className="toolbar" role="toolbar" aria-label="Conversation actions">
        <IconButton label="Back to list" onClick={back}><ArrowLeft size={20} /></IconButton>
        {inInbox && !inTrash && !inSpam && (
          <IconButton label="Archive" onClick={() => void act({ action: "archive" }, true)}><Archive size={18} /></IconButton>
        )}
        {!inInbox && !inSpam && (folder.kind === "archive" || folder.kind === "folder" || inTrash) && (
          <IconButton label="Move to Inbox" onClick={() => void act({ action: "inbox" }, true)}><ArchiveRestore size={18} /></IconButton>
        )}
        {inSpam ? (
          <IconButton label="Not spam" onClick={() => void act({ action: "notspam" }, true)}><Inbox size={18} /></IconButton>
        ) : !inTrash && (
          <IconButton label="Report spam" onClick={() => void act({ action: "spam" }, true)}><OctagonAlert size={18} /></IconButton>
        )}
        <IconButton label={inTrash || inSpam ? "Delete forever" : "Delete"} onClick={() => void act({ action: inTrash || inSpam ? "delete" : "trash" }, true)}>
          <Trash2 size={18} />
        </IconButton>
        <span className="divider" />
        <IconButton label="Mark as unread" onClick={() => void act({ action: "unread" }, true)}><Mail size={18} /></IconButton>
        <MovePicker
          open={menu === "move"}
          onOpenChange={(o) => setMenu(o ? "move" : null)}
          exclude={folder.kind === "folder" ? folder.id : undefined}
          trigger={<IconButton label="Move to"><FolderInput size={18} /></IconButton>}
          onPick={(mb) => { setMenu(null); void act({ action: "move", target: mb.id }, true); }}
        />
        <LabelPicker
          open={menu === "label"}
          onOpenChange={(o) => setMenu(o ? "label" : null)}
          applied={labelState}
          trigger={<IconButton label="Labels"><Tag size={18} /></IconButton>}
          onToggle={(keyword, add) => void act({ action: add ? "label" : "unlabel", keyword }, false)}
        />
        <span className="grow" />
        {idx >= 0 && (
          <span className="range">{(offset + idx + 1).toLocaleString()} of {total.toLocaleString()}</span>
        )}
        <IconButton label="Newer" disabled={idx <= 0} onClick={() => go(-1)}><ChevronLeft size={18} /></IconButton>
        <IconButton label="Older" disabled={idx < 0 || idx >= ids.length - 1} onClick={() => go(1)}><ChevronRight size={18} /></IconButton>
      </div>

      <div className="conversation">
        {query.isPending ? (
          <div className="empty"><div className="spinner lg" /></div>
        ) : !conv ? (
          <div className="empty">
            <div>
              <h3>This conversation isn't here any more</h3>
              <p>It may have been moved or deleted.</p>
              <button type="button" className="btn btn-outline" onClick={back}>Back to the list</button>
            </div>
          </div>
        ) : (
          <>
            <div className="conv-head">
              <h2 className="conv-subject">
                {conv.subject || "(no subject)"}
                {inInbox && folder.kind !== "inbox" && <span className="chip lg">Inbox</span>}
                {inInbox && folder.kind === "inbox" && (
                  <LabelChip large keyword="Inbox" label={{ keyword: "Inbox", name: "Inbox", color: null, total: 0, unread: 0 }} onRemove={() => void act({ action: "archive" }, true)} />
                )}
                {conv.labels.map((k) => (
                  <LabelChip key={k} large keyword={k} label={acct.labelByKeyword.get(k)} onRemove={() => void act({ action: "unlabel", keyword: k }, false)} />
                ))}
              </h2>
            </div>
            <div className="messages">
              {visible.map((m, i) =>
                "more" in m ? (
                  <div key="more" className="msg-more" role="button" tabIndex={0} onClick={() => setShowAll(true)} onKeyDown={(e) => e.key === "Enter" && setShowAll(true)}>
                    <span>{m.more}</span>
                  </div>
                ) : (
                  <MessageCard
                    key={keyOf(m)}
                    conv={conv}
                    msg={m}
                    open={expanded.has(keyOf(m))}
                    focused={messages.indexOf(m) === focusIdx}
                    last={i === visible.length - 1}
                    onToggle={() => setExpanded((s) => { const n = new Set(s); n.has(keyOf(m)) ? n.delete(keyOf(m)) : n.add(keyOf(m)); return n; })}
                    onReply={(mode) => reply(m, mode)}
                  />
                ),
              )}
            </div>
            {inline ? (
              <Suspense fallback={<div className="reply-bar"><span className="spinner" /></div>}>
                <InlineCompose compose={inline} />
              </Suspense>
            ) : (
              lastReal && !lastReal.draft && (
                <div className="reply-bar">
                  <button type="button" className="btn btn-outline" onClick={() => reply(lastReal, "reply")}><Reply size={18} /> Reply</button>
                  {lastReal.to.length + lastReal.cc.length > 1 && (
                    <button type="button" className="btn btn-outline" onClick={() => reply(lastReal, "replyAll")}><ReplyAll size={18} /> Reply all</button>
                  )}
                  <button type="button" className="btn btn-outline" onClick={() => reply(lastReal, "forward")}><Forward size={18} /> Forward</button>
                </div>
              )
            )}
          </>
        )}
      </div>
    </>
  );
}

function MessageCard({
  conv,
  msg,
  open,
  focused,
  last,
  onToggle,
  onReply,
}: {
  conv: Conversation;
  msg: MessageMeta;
  open: boolean;
  focused: boolean;
  last: boolean;
  onToggle: () => void;
  onReply: (mode: "reply" | "replyAll" | "forward") => void;
}) {
  const acct = useAccount();
  const client = useQueryClient();
  const ref: MessageRef = { mailboxId: msg.mailboxId, uid: msg.uid };
  const from = msg.from[0];
  const isMe = !!from && acct.me.has(from.address);
  const card = useRef<HTMLDivElement>(null);
  const config = useConfig().data;
  const contactsOn = !!config?.contacts;

  useEffect(() => {
    if (focused) card.current?.scrollIntoView({ block: "nearest" });
  }, [focused]);

  const star = (e: React.MouseEvent) => {
    e.stopPropagation();
    void runAction(client, acct.index, { kind: "all" }, { action: msg.flagged ? "unstar" : "star", messages: [ref] }, { quiet: true });
  };

  if (msg.draft) {
    return (
      <div className="msg" ref={card}>
        <div className="msg-collapsed" role="button" tabIndex={0}
          onClick={() => void openDraft(acct.index, ref, acct.identities).catch((err) => toast(err.message, { error: true }))}>
          <Avatar person={from} size={40} />
          <span className="who" style={{ color: "var(--danger)" }}>Draft</span>
          <span className="snip">{msg.snippet || "(empty draft)"}</span>
          <span className="when">{listDate(msg.date)}</span>
        </div>
      </div>
    );
  }

  if (!open) {
    return (
      <div className={`msg ${focused ? "focused" : ""}`} ref={card}>
        <div className={`msg-collapsed ${msg.seen ? "read" : ""}`} role="button" tabIndex={0} onClick={onToggle} onKeyDown={(e) => e.key === "Enter" && onToggle()}>
          <Avatar person={from} size={40} />
          <span className="who">{isMe ? "me" : displayName(from)}</span>
          <span className="snip">{msg.snippet}</span>
          {msg.attachments > 0 && <Paperclip size={14} style={{ color: "var(--text-muted)" }} />}
          <span className="when">{listDate(msg.date)}</span>
        </div>
      </div>
    );
  }

  const recipients = [...msg.to, ...msg.cc];
  const toLine = recipients.length
    ? recipients.map((a) => (acct.me.has(a.address) ? "me" : displayName(a).split(/\s+/)[0])).slice(0, 4).join(", ") + (recipients.length > 4 ? ", …" : "")
    : "undisclosed recipients";

  return (
    <div className={`msg ${focused ? "focused" : ""}`} ref={card}>
      <div className="msg-open">
        <div className="msg-header">
          <Avatar person={from} size={40} />
          <div className="ident" onClick={onToggle} style={{ cursor: last ? "default" : "pointer" }}>
            <div className="from-line">
              <span className="from-name">{displayName(from) || "(unknown sender)"}</span>
              {from?.name && <span className="from-addr">&lt;{from.address}&gt;</span>}
            </div>
            <Popover.Root>
              <Popover.Trigger asChild>
                <button type="button" className="to-line" onClick={(e) => e.stopPropagation()}>
                  to {toLine} <ChevronDown size={14} />
                </button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content className="popover" align="start" sideOffset={4}>
                  <dl className="details-pop">
                    <dt>from:</dt><dd>{msg.from.map((a) => `${a.name ? `${a.name} ` : ""}<${a.address}>`).join(", ")}</dd>
                    {msg.replyTo.length > 0 && msg.replyTo[0].address !== from?.address && (<><dt>reply-to:</dt><dd>{msg.replyTo.map((a) => a.address).join(", ")}</dd></>)}
                    <dt>to:</dt><dd>{msg.to.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(", ") || "—"}</dd>
                    {msg.cc.length > 0 && (<><dt>cc:</dt><dd>{msg.cc.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(", ")}</dd></>)}
                    {msg.bcc.length > 0 && (<><dt>bcc:</dt><dd>{msg.bcc.map((a) => a.address).join(", ")}</dd></>)}
                    <dt>date:</dt><dd>{new Date(msg.date).toLocaleString()}</dd>
                    <dt>subject:</dt><dd>{msg.subject}</dd>
                    <dt>folder:</dt><dd>{msg.mailboxIds.map((id) => acct.mailboxById.get(id)?.name).filter(Boolean).join(", ")}</dd>
                  </dl>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          </div>
          <div className="tools">
            {msg.attachments > 0 && <Paperclip size={14} />}
            <span className="when" title={new Date(msg.date).toLocaleString()}>{fullDate(msg.date)}</span>
            <button type="button" className={`star-btn ${msg.flagged ? "on" : ""}`} aria-label={msg.flagged ? "Starred" : "Not starred"} onClick={star}>
              <Star size={18} fill={msg.flagged ? "currentColor" : "none"} />
            </button>
            <IconButton label="Reply" size="sm" onClick={() => onReply("reply")}><Reply size={18} /></IconButton>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <IconButton label="More" size="sm"><EllipsisVertical size={18} /></IconButton>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content className="menu" align="end" sideOffset={4}>
                  <DropdownMenu.Item className="menu-item" onSelect={() => onReply("reply")}><Reply size={18} /> Reply</DropdownMenu.Item>
                  <DropdownMenu.Item className="menu-item" onSelect={() => onReply("replyAll")}><ReplyAll size={18} /> Reply all</DropdownMenu.Item>
                  <DropdownMenu.Item className="menu-item" onSelect={() => onReply("forward")}><Forward size={18} /> Forward</DropdownMenu.Item>
                  <DropdownMenu.Separator className="menu-sep" />
                  <DropdownMenu.Item className="menu-item" onSelect={() => void runAction(client, acct.index, { kind: "all" }, { action: "trash", messages: [ref] })}>
                    <Trash2 size={18} /> Delete this message
                  </DropdownMenu.Item>
                  <DropdownMenu.Item className="menu-item" onSelect={() => {
                    const later = conv.messages.filter((m) => m.date >= msg.date).map((m) => ({ mailboxId: m.mailboxId, uid: m.uid }));
                    void runAction(client, acct.index, { kind: "all" }, { action: "unread", messages: later });
                  }}>
                    <Mail size={18} /> Mark unread from here
                  </DropdownMenu.Item>
                  {(contactsOn || config?.filters) && from && !isMe && <DropdownMenu.Separator className="menu-sep" />}
                  {contactsOn && from && !isMe && (
                    <DropdownMenu.Item className="menu-item" onSelect={() => void addToContacts(acct.index, from)}>
                      <UserPlus size={18} /> Add {displayName(from).split(/\s+/)[0] || from.address} to contacts
                    </DropdownMenu.Item>
                  )}
                  {config?.filters && from && !isMe && (
                    <DropdownMenu.Item className="menu-item" onSelect={() => ui.set((s) => ({ ...s, filterDialog: { criteria: { from: from.address } } }))}>
                      <ListFilter size={18} /> Filter messages like these
                    </DropdownMenu.Item>
                  )}
                  <DropdownMenu.Separator className="menu-sep" />
                  <DropdownMenu.Item className="menu-item" onSelect={() => window.open(api.rawUrl(acct.index, ref), "_blank", "noopener")}>
                    <FileText size={18} /> Show original
                  </DropdownMenu.Item>
                  <DropdownMenu.Item className="menu-item" onSelect={() => (location.href = api.rawUrl(acct.index, ref, true))}>
                    <Download size={18} /> Download message
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        </div>
        <MessageBody msg={msg} />
      </div>
    </div>
  );
}

function MessageBody({ msg }: { msg: MessageMeta }) {
  const acct = useAccount();
  const client = useQueryClient();
  const ref: MessageRef = { mailboxId: msg.mailboxId, uid: msg.uid };
  const [showImages, setShowImages] = useState(false);
  const query = useQuery({
    queryKey: ["message", acct.index, msg.mailboxId, msg.uid, showImages],
    queryFn: () => api.message(acct.index, ref, showImages),
    staleTime: Infinity,
  });
  const r = query.data;
  const sender = msg.from[0]?.address;

  const mailto = (href: string) => {
    const url = new URL(href);
    const to = decodeURIComponent(url.pathname).split(",").filter(Boolean).map((address) => ({ address }));
    openCompose(acct.index, acct.identities[0], acct.settings?.signature ?? "", {
      to,
      subject: url.searchParams.get("subject") ?? "",
    });
  };

  if (query.isPending) return <div className="msg-body"><div className="spinner" /></div>;
  if (query.isError || !r) {
    return (
      <div className="msg-body" style={{ color: "var(--danger)" }}>
        Couldn't load this message ({(query.error as Error)?.message}).{" "}
        <button type="button" className="btn btn-text" onClick={() => void query.refetch()}>Retry</button>
      </div>
    );
  }
  const files = r.attachments.filter((a) => !a.inline);
  return (
    <>
      {r.remoteContent && !r.imagesAllowed && (
        <div className="images-banner">
          <span>Images in this message are hidden.</span>
          <button type="button" onClick={() => setShowImages(true)}>Display images below</button>
          {sender && (
            <button type="button" onClick={async () => {
              await api.trustSender(acct.index, sender);
              setShowImages(true);
              void client.invalidateQueries({ queryKey: ["message", acct.index] });
            }}>
              Always display images from {sender}
            </button>
          )}
        </div>
      )}
      <div className={`msg-body ${r.plain ? "" : "html-mail"}`}>
        {r.unsubscribe && (
          <div style={{ textAlign: "right", marginBottom: 4 }}>
            <a className="unsub" href={r.unsubscribe.url ?? r.unsubscribe.mailto} target="_blank" rel="noopener noreferrer">Unsubscribe</a>
          </div>
        )}
        <EmailFrame html={r.html} plain={r.plain} onMailto={mailto} />
      </div>
      {files.length > 0 && <Attachments refx={ref} files={files} />}
    </>
  );
}

function Attachments({ refx, files }: { refx: MessageRef; files: AttachmentInfo[] }) {
  const acct = useAccount();
  return (
    <div className="attachments">
      <div className="attachments-title">
        {files.length === 1 ? "One attachment" : `${files.length} attachments`}
      </div>
      {files.map((f) => {
        const isImage = /^image\/(png|jpe?g|gif|webp)$/i.test(f.contentType);
        const viewable = isImage || f.contentType === "application/pdf" || f.contentType === "text/plain";
        const inlineUrl = api.attachmentUrl(acct.index, refx, f.index, true);
        const downloadUrl = api.attachmentUrl(acct.index, refx, f.index);
        return (
          <div key={f.index} className="att-card" title={`${f.filename} (${fileSize(f.size)})`}>
            <div className="thumb" style={isImage ? { backgroundImage: `url("${inlineUrl}")` } : undefined}>
              {!isImage && <FileText size={40} />}
            </div>
            <div className="label">
              {isImage ? <Paperclip size={16} /> : <FileText size={16} />}
              <span>{f.filename}</span>
            </div>
            <div className="overlay">
              <a className="icon-btn" href={downloadUrl} download={f.filename} aria-label={`Download ${f.filename}`}><Download size={20} /></a>
              {viewable && (
                <a className="icon-btn" href={inlineUrl} target="_blank" rel="noopener noreferrer" aria-label={`Open ${f.filename}`}><ExternalLink size={20} /></a>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
