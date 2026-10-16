import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useQueryClient } from "@tanstack/react-query";
import { Archive, ChevronDown, ChevronUp, EllipsisVertical, File, Folder, FolderPlus, Inbox, Mails, OctagonAlert, Pencil, Plus, Send, Star, Tag, Trash2 } from "lucide-react";
import { type DragEvent, type ReactNode, useState } from "react";
import { ui, useAccount } from "../lib/account";
import { runAction } from "../lib/actions";
import { openCompose } from "../lib/compose";
import { type Folder as FolderRoute, type Route, folderPath, navigate, sameFolder } from "../lib/router";
import { readLocal, writeLocal } from "../lib/store";
import type { Mailbox } from "../lib/types";
import { IconButton, confirmDeleteFolder, confirmRemoveLabel } from "./common";

export const THREAD_DRAG = "application/x-viauna-threads";

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
  menu,
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
  /** Actions for this item, behind a ⋮ button shown on hover. */
  menu?: ReactNode;
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
    <li className={menu ? "has-menu" : undefined}>
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
      {menu && (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button type="button" className="icon-btn xs nav-menu-btn" aria-label={`Options for ${label}`}>
              <EllipsisVertical size={16} />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="menu" align="start" sideOffset={4}>
              {menu}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}
    </li>
  );
}

/**
 * Where a folder sits among the folders actually listed. One whose parent isn't
 * there (deleted, or a special folder like Archive) goes up a level and shows the
 * path from its nearest listed ancestor, rather than indented under nothing.
 */
function placement(mb: Mailbox, listed: Set<string>): { depth: number; name: string } {
  if (!mb.delimiter) return { depth: 0, name: mb.name };
  const parts = mb.path.split(mb.delimiter);
  let depth = 0;
  let nearest = 0;
  for (let i = 1; i < parts.length; i++) {
    if (listed.has(parts.slice(0, i).join(mb.delimiter))) {
      depth++;
      nearest = i;
    }
  }
  return { depth, name: parts.slice(nearest).join(mb.delimiter) };
}

export function Sidebar({ route, collapsed, open }: { route: Route; collapsed: boolean; open: boolean }) {
  const acct = useAccount();
  const client = useQueryClient();
  const [more, setMore] = useState(() => readLocal("viauna.sidebar.more", false));
  const a = acct.index;
  const current = route.name === "mail" ? route.folder : null;
  const isActive = (f: FolderRoute) => !!current && sameFolder(current, f);
  const s = acct.special;
  const folders = acct.mailboxes.filter((m) => !m.specialUse).sort((x, y) => x.path.localeCompare(y.path));
  const listed = new Set(folders.map((m) => m.path));

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
          <button type="button" className="nav-item" onClick={() => { setMore(!more); writeLocal("viauna.sidebar.more", !more); }} aria-expanded={more}>
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
              menu={
                <>
                  <DropdownMenu.Item className="menu-item" onSelect={() => ui.set((st) => ({ ...st, labelDialog: { label: l } }))}>
                    <Pencil size={18} /> Edit
                  </DropdownMenu.Item>
                  <DropdownMenu.Item className="menu-item" onSelect={() => confirmRemoveLabel(client, a, l)}>
                    <Trash2 size={18} /> Remove label
                  </DropdownMenu.Item>
                </>
              }
            />
          );
        })}
      </ul>

      <div className="nav-section">
        <span>Folders</span>
        <IconButton label="Create new folder" size="sm" onClick={() => ui.set((st) => ({ ...st, folderDialog: {} }))}>
          <Plus size={18} />
        </IconButton>
      </div>
      <ul className="nav">
        {folders.map((m) => {
          const f: FolderRoute = { kind: "folder", id: m.id };
          const at = placement(m, listed);
          return (
            <NavItem
              key={m.id}
              icon={<Folder size={18} />}
              label={at.name}
              title={m.path}
              indent={at.depth}
              count={m.unread}
              bold={m.unread > 0}
              to={m.selectable ? folderPath(a, f) : "#"}
              active={isActive(f)}
              onDropThreads={m.selectable ? dropTo(m, "move") : undefined}
              menu={
                <>
                  <DropdownMenu.Item className="menu-item" onSelect={() => ui.set((st) => ({ ...st, folderDialog: { mailbox: m } }))}>
                    <Pencil size={18} /> Rename
                  </DropdownMenu.Item>
                  <DropdownMenu.Item className="menu-item" onSelect={() => ui.set((st) => ({ ...st, folderDialog: { parentId: m.id } }))}>
                    <FolderPlus size={18} /> New subfolder
                  </DropdownMenu.Item>
                  <DropdownMenu.Item className="menu-item" onSelect={() => confirmDeleteFolder(client, a, m, acct.mailboxes)}>
                    <Trash2 size={18} /> Delete folder
                  </DropdownMenu.Item>
                </>
              }
            />
          );
        })}
      </ul>
    </nav>
  );
}
