// "Label as" and "Move to" menus: a popover with a filter box, like Gmail's.
import * as Popover from "@radix-ui/react-popover";
import { Folder, Inbox, Plus, Square, SquareCheck, SquareMinus } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { ui, useAccount } from "../lib/account";
import type { Mailbox } from "../lib/types";

export function LabelPicker({
  trigger,
  applied,
  onToggle,
  open,
  onOpenChange,
}: {
  trigger: ReactNode;
  /** keyword -> "all" | "some" (on some of the selected conversations) */
  applied: Map<string, "all" | "some">;
  onToggle: (keyword: string, add: boolean) => void;
  open?: boolean;
  onOpenChange?: (o: boolean) => void;
}) {
  const acct = useAccount();
  const [q, setQ] = useState("");
  const list = useMemo(
    () => acct.labels.filter((l) => l.name.toLowerCase().includes(q.trim().toLowerCase())),
    [acct.labels, q],
  );
  return (
    <Popover.Root open={open} onOpenChange={(o) => { onOpenChange?.(o); if (!o) setQ(""); }}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="menu" align="start" sideOffset={4} onOpenAutoFocus={(e) => e.preventDefault()}>
          <div className="menu-label">Label as:</div>
          <div className="menu-search">
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search labels" aria-label="Search labels"
              onKeyDown={(e) => {
                if (e.key === "Enter" && list[0]) onToggle(list[0].keyword, applied.get(list[0].keyword) !== "all");
              }}
            />
          </div>
          <div className="menu-scroll">
            {list.map((l) => {
              const state = applied.get(l.keyword);
              const Icon = state === "all" ? SquareCheck : state === "some" ? SquareMinus : Square;
              return (
                <div key={l.keyword} role="menuitemcheckbox" aria-checked={state === "all"} tabIndex={0} className="menu-item"
                  onClick={() => onToggle(l.keyword, state !== "all")}
                  onKeyDown={(e) => e.key === "Enter" && onToggle(l.keyword, state !== "all")}
                >
                  <Icon size={18} />
                  <span style={{ flex: 1 }}>{l.name}</span>
                  {l.color && <span className="label-swatch" style={{ background: l.color, borderRadius: 3, width: 12, height: 12 }} />}
                </div>
              );
            })}
            {!list.length && <div className="menu-label">No labels{q ? ` matching "${q}"` : ""}</div>}
          </div>
          <div className="menu-sep" />
          <div className="menu-item" role="menuitem" tabIndex={0} onClick={() => { onOpenChange?.(false); ui.set((s) => ({ ...s, labelDialog: {} })); }}>
            <Plus size={18} /> Create new
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function depth(mb: Mailbox): number {
  return mb.delimiter ? mb.path.split(mb.delimiter).length - 1 : 0;
}

export function MovePicker({
  trigger,
  onPick,
  exclude,
  open,
  onOpenChange,
}: {
  trigger: ReactNode;
  onPick: (mb: Mailbox) => void;
  exclude?: number | null;
  open?: boolean;
  onOpenChange?: (o: boolean) => void;
}) {
  const acct = useAccount();
  const [q, setQ] = useState("");
  const targets = useMemo(() => {
    const order = ["inbox", "archive", null, "junk", "trash"];
    return acct.mailboxes
      .filter((m) => m.selectable && m.id !== exclude && m.specialUse !== "sent" && m.specialUse !== "drafts")
      .filter((m) => m.path.toLowerCase().includes(q.trim().toLowerCase()))
      .sort((a, b) => order.indexOf(a.specialUse) - order.indexOf(b.specialUse) || a.path.localeCompare(b.path));
  }, [acct.mailboxes, exclude, q]);
  const names: Record<string, string> = { inbox: "Inbox", archive: "Archive", junk: "Spam", trash: "Trash" };
  return (
    <Popover.Root open={open} onOpenChange={(o) => { onOpenChange?.(o); if (!o) setQ(""); }}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="menu" align="start" sideOffset={4}>
          <div className="menu-label">Move to:</div>
          <div className="menu-search">
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search folders" aria-label="Search folders"
              onKeyDown={(e) => {
                if (e.key === "Enter" && targets[0]) onPick(targets[0]);
              }}
            />
          </div>
          <div className="menu-scroll">
            {targets.map((m) => (
              <div key={m.id} className="menu-item" role="menuitem" tabIndex={0} onClick={() => onPick(m)} onKeyDown={(e) => e.key === "Enter" && onPick(m)}
                style={{ paddingLeft: 16 + depth(m) * 16 }}
              >
                {m.specialUse === "inbox" ? <Inbox size={18} /> : <Folder size={18} />}
                <span>{m.specialUse ? (names[m.specialUse] ?? m.name) : m.name}</span>
              </div>
            ))}
            {!targets.length && <div className="menu-label">No folders</div>}
          </div>
          <div className="menu-sep" />
          <div className="menu-item" role="menuitem" tabIndex={0} onClick={() => { onOpenChange?.(false); ui.set((s) => ({ ...s, folderDialog: {} })); }}>
            <Plus size={18} /> Create new folder
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

