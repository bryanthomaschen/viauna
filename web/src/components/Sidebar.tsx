import { useQueryClient } from "@tanstack/react-query";
import { Archive, ChevronDown, ChevronUp, File, Folder, Inbox, Mails, OctagonAlert, Pencil, Plus, Send, Star, Tag, Trash2 } from "lucide-react";
import { type DragEvent, type ReactNode, useState } from "react";
import { ui, useAccount } from "../lib/account";
import { runAction } from "../lib/actions";
import { openCompose } from "../lib/compose";
import { type Folder as FolderRoute, type Route, folderPath, navigate, sameFolder } from "../lib/router";
import { readLocal, writeLocal } from "../lib/store";
import type { Mailbox } from "../lib/types";
import { IconButton } from "./common";

export const THREAD_DRAG = "application/x-wren-threads";

function NavItem({
  icon,
  label,
  count,
  bold,
  active,
  to,
  indent = 0,
  onDropThreads,
  title,
}: {
  icon: ReactNode;
  label: string;
  count?: number;
  bold?: boolean;
  active: boolean;
  to: string;
  indent?: number;
  onDropThreads?: (ids: number[]) => void;
  title?: string;
}) {
  const [over, setOver] = useState(false);
  const drop = onDropThreads
    ? {
        onDragOver: (e: DragEvent) => {
          if (e.dataTransfer.types.includes(THREAD_DRAG)) {
            e.preventDefault();
            setOver(true);
          }
        },
        onDragLeave: () => setOver(false),
        onDrop: (e: DragEvent) => {
          setOver(false);
          const ids = JSON.parse(e.dataTransfer.getData(THREAD_DRAG) || "[]") as number[];
          if (ids.length) onDropThreads(ids);
        },
      }
    : {};
  return (
    <li>
      <a
        href={to}
        title={title ?? label}
        className={`nav-item ${active ? "active" : ""} ${bold ? "unread" : ""} ${over ? "drop-target" : ""} ${indent ? `nav-indent-${Math.min(indent, 2)}` : ""}`}
        aria-current={active ? "page" : undefined}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey) return;
          e.preventDefault();
          ui.set((s) => ({ ...s, sidebarOpen: false }));
          navigate(to);
        }}
        {...drop}
      >
        {icon}
        <span className="nav-label">{label}</span>
        {!!count && <span className="nav-count">{count.toLocaleString()}</span>}
      </a>
    </li>
  );
}

function depth(mb: Mailbox): number {
  return mb.delimiter ? mb.path.split(mb.delimiter).length - 1 : 0;
}

export function Sidebar({ route, collapsed, open }: { route: Route; collapsed: boolean; open: boolean }) {
  const acct = useAccount();
  const client = useQueryClient();
  const [more, setMore] = useState(() => readLocal("wren.sidebar.more", false));
  const a = acct.index;
  const current = route.name === "mail" ? route.folder : null;
  const isActive = (f: FolderRoute) => !!current && sameFolder(current, f);
  const s = acct.special;
  const folders = acct.mailboxes.filter((m) => !m.specialUse).sort((x, y) => x.path.localeCompare(y.path));

  const dropTo = (target: Mailbox | undefined, action: "move" | "trash" | "spam" | "archive" | "inbox") =>
    target
      ? (ids: number[]) =>
          void runAction(client, a, current ?? { kind: "inbox" }, action === "move" ? { action, threads: ids, target: target.id } : { action, threads: ids })
      : undefined;

  const compose = () =>
    openCompose(a, acct.identities[0], acct.settings?.signature ?? "", { from: acct.identities[0].address });

  return (
    <nav className={`sidebar ${collapsed ? "collapsed" : ""} ${open ? "open" : ""}`} aria-label="Mailboxes">
      <button type="button" className="compose-btn" onClick={compose} title="Compose (c)">
        <Pencil size={22} />
        <span>Compose</span>
      </button>
      <ul className="nav">
        <NavItem icon={<Inbox size={20} />} label="Inbox" to={folderPath(a, { kind: "inbox" })} active={isActive({ kind: "inbox" })}
          count={s.inbox?.unread} bold={!!s.inbox?.unread} onDropThreads={dropTo(s.inbox, "inbox")} />
        <NavItem icon={<Star size={20} />} label="Starred" to={folderPath(a, { kind: "starred" })} active={isActive({ kind: "starred" })} />
        <NavItem icon={<Send size={20} />} label="Sent" to={folderPath(a, { kind: "sent" })} active={isActive({ kind: "sent" })} />
        <NavItem icon={<File size={20} />} label="Drafts" to={folderPath(a, { kind: "drafts" })} active={isActive({ kind: "drafts" })}
          count={s.drafts?.total} bold={!!s.drafts?.total} />
        {s.archive && (
          <NavItem icon={<Archive size={20} />} label="Archive" to={folderPath(a, { kind: "archive" })} active={isActive({ kind: "archive" })}
            onDropThreads={dropTo(s.archive, "archive")} />
        )}
        <li>
          <button type="button" className="nav-item" onClick={() => { setMore(!more); writeLocal("wren.sidebar.more", !more); }} aria-expanded={more}>
            {more ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
            <span className="nav-label nav-more-label">{more ? "Less" : "More"}</span>
          </button>
        </li>
        {more && (
          <>
            <NavItem icon={<Mails size={20} />} label="All Mail" to={folderPath(a, { kind: "all" })} active={isActive({ kind: "all" })} />
            <NavItem icon={<OctagonAlert size={20} />} label="Spam" to={folderPath(a, { kind: "spam" })} active={isActive({ kind: "spam" })}
              count={s.junk?.unread} bold={!!s.junk?.unread} onDropThreads={dropTo(s.junk, "spam")} />
            <NavItem icon={<Trash2 size={20} />} label="Trash" to={folderPath(a, { kind: "trash" })} active={isActive({ kind: "trash" })}
              onDropThreads={dropTo(s.trash, "trash")} />
          </>
        )}
      </ul>

      <div className="nav-section">
        <span>Labels</span>
        <IconButton label="Create new label" size="sm" onClick={() => ui.set((st) => ({ ...st, labelDialog: {} }))}>
          <Plus size={18} />
        </IconButton>
      </div>
      <ul className="nav">
        {acct.labels.map((l) => {
          const f: FolderRoute = { kind: "label", keyword: l.keyword };
          return (
            <NavItem
              key={l.keyword}
              icon={<Tag size={18} className="label-swatch" style={l.color ? { color: l.color, fill: l.color } : undefined} />}
              label={l.name}
              count={l.unread}
              bold={l.unread > 0}
              to={folderPath(a, f)}
              active={isActive(f)}
              onDropThreads={(ids) => void runAction(client, a, current ?? { kind: "inbox" }, { action: "label", threads: ids, keyword: l.keyword })}
            />
          );
        })}
      </ul>

      {(
        <>
          <div className="nav-section">
            <span>Folders</span>
            <IconButton label="Create new folder" size="sm" onClick={() => ui.set((st) => ({ ...st, folderDialog: {} }))}>
              <Plus size={18} />
            </IconButton>
          </div>
          <ul className="nav">
            {folders.map((m) => {
              const f: FolderRoute = { kind: "folder", id: m.id };
              return (
                <NavItem
                  key={m.id}
                  icon={<Folder size={18} />}
                  label={m.name}
                  title={m.path}
                  indent={depth(m)}
                  count={m.unread}
                  bold={m.unread > 0}
                  to={m.selectable ? folderPath(a, f) : "#"}
                  active={isActive(f)}
                  onDropThreads={m.selectable ? dropTo(m, "move") : undefined}
                />
              );
            })}
          </ul>
        </>
      )}
    </nav>
  );
}
