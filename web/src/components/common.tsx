import * as Dialog from "@radix-ui/react-dialog";
import * as Tooltip from "@radix-ui/react-tooltip";
import { useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { type ButtonHTMLAttributes, type ReactNode, forwardRef, useEffect, useState } from "react";
import { ui, useAccount } from "../lib/account";
import { api } from "../lib/api";
import { avatarColor, initial } from "../lib/format";
import { dismissToast, toast, toasts } from "../lib/store";
import type { Address } from "../lib/types";

export function Avatar({ person, size = 40 }: { person: Address | undefined; size?: number }) {
  const seed = person?.address ?? "?";
  return (
    <span className="avatar" style={{ width: size, height: size, background: avatarColor(seed), fontSize: size * 0.45 }} aria-hidden>
      {initial(person)}
    </span>
  );
}

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { label: string; size?: "sm" | "xs"; children: ReactNode };

/** A round icon button with a tooltip; the label is also its accessible name. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({ label, size, children, className, ...rest }, ref) {
  return (
    <Tooltip.Root delayDuration={500}>
      <Tooltip.Trigger asChild>
        <button ref={ref} type="button" aria-label={label} className={`icon-btn ${size ?? ""} ${className ?? ""}`} {...rest}>
          {children}
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip" sideOffset={4}>
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
});

export function Toasts() {
  const list = toasts.use();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast ${t.error ? "error" : ""}`}>
          <span className="t">{t.text}</span>
          {t.action && (
            <button
              type="button"
              className="act"
              onClick={() => {
                t.action!.run();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button type="button" className="x" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
            <X size={18} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog" aria-describedby={undefined}>
          <Dialog.Title asChild>
            <h2>{title}</h2>
          </Dialog.Title>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const SHORTCUTS: [string, string][] = [
  ["c", "Compose"],
  ["/", "Search mail"],
  ["j / k", "Older / newer conversation"],
  ["o or Enter", "Open conversation"],
  ["u", "Back to the list"],
  ["n / p", "Next / previous message"],
  ["e", "Archive"],
  ["#", "Delete"],
  ["!", "Report spam"],
  ["s", "Star / unstar"],
  ["x", "Select conversation"],
  ["Shift + i", "Mark as read"],
  ["Shift + u", "Mark as unread"],
  ["l", "Label as"],
  ["v", "Move to"],
  ["r", "Reply"],
  ["a", "Reply all"],
  ["f", "Forward"],
  ["z", "Undo last action"],
  ["g then i", "Go to Inbox"],
  ["g then s", "Go to Starred"],
  ["g then t", "Go to Sent"],
  ["g then d", "Go to Drafts"],
  ["g then a", "Go to All Mail"],
  ["Ctrl + Enter", "Send"],
  ["Esc", "Close / clear selection"],
  ["?", "These shortcuts"],
];

export function Dialogs() {
  const state = ui.use();
  return (
    <>
      <Modal open={state.shortcutsOpen} onClose={() => ui.set((s) => ({ ...s, shortcutsOpen: false }))} title="Keyboard shortcuts">
        <div className="shortcut-grid">
          {SHORTCUTS.map(([k, v]) => (
            <div key={k}>
              <span>{v}</span>
              <kbd>{k}</kbd>
            </div>
          ))}
        </div>
      </Modal>
      {state.labelDialog && <LabelDialog />}
      {state.folderDialog && <FolderDialog />}
    </>
  );
}

export const LABEL_COLORS = [
  "#fb4c2f", "#ffad47", "#fad165", "#16a766", "#43d692", "#4a86e8", "#a479e2", "#f691b3",
  "#f6c5be", "#ffe6c7", "#fef1d1", "#b9e4d0", "#c6f3de", "#c9daf8", "#e4d7f5", "#fcdee8", "#cccccc", "#666666",
];

function LabelDialog() {
  const acct = useAccount();
  const client = useQueryClient();
  const existing = ui.use((s) => s.labelDialog?.label);
  const [name, setName] = useState(existing?.name ?? "");
  const [color, setColor] = useState<string | null>(existing?.color ?? null);
  const [busy, setBusy] = useState(false);
  const close = () => ui.set((s) => ({ ...s, labelDialog: null }));
  const save = async () => {
    setBusy(true);
    try {
      if (existing) await api.updateLabel(acct.index, existing.keyword, { name, color });
      else await api.createLabel(acct.index, name, color);
      await client.invalidateQueries({ queryKey: ["mailboxes", acct.index] });
      void client.invalidateQueries({ queryKey: ["threads", acct.index] });
      close();
    } catch (err) {
      toast((err as Error).message, { error: true });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={close} title={existing ? "Edit label" : "New label"}>
      <label className="sr-only" htmlFor="label-name">Label name</label>
      <input
        id="label-name"
        className="text-input"
        placeholder="Please enter a new label name"
        value={name}
        autoFocus
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && name.trim() && void save()}
      />
      <div className="color-grid" role="radiogroup" aria-label="Label colour">
        <button type="button" className={`color-dot ${color === null ? "on" : ""}`} style={{ background: "var(--chip)" }} aria-label="No colour" onClick={() => setColor(null)} />
        {LABEL_COLORS.map((c) => (
          <button key={c} type="button" className={`color-dot ${color === c ? "on" : ""}`} style={{ background: c }} aria-label={c} onClick={() => setColor(c)} />
        ))}
      </div>
      <div className="buttons">
        <button type="button" className="btn btn-text" onClick={close}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={!name.trim() || busy} onClick={() => void save()}>
          {existing ? "Save" : "Create"}
        </button>
      </div>
    </Modal>
  );
}

function FolderDialog() {
  const acct = useAccount();
  const client = useQueryClient();
  const existing = ui.use((s) => s.folderDialog?.mailbox);
  const [name, setName] = useState(existing?.name ?? "");
  const [parent, setParent] = useState<number | "">("");
  const [busy, setBusy] = useState(false);
  const close = () => ui.set((s) => ({ ...s, folderDialog: null }));
  const folders = acct.mailboxes.filter((m) => !m.specialUse && m.id !== existing?.id);
  const save = async () => {
    setBusy(true);
    try {
      if (existing) await api.renameMailbox(acct.index, existing.id, name.trim());
      else await api.createMailbox(acct.index, name.trim(), parent === "" ? undefined : parent);
      setTimeout(() => void client.invalidateQueries({ queryKey: ["mailboxes", acct.index] }), 600);
      close();
    } catch (err) {
      toast((err as Error).message, { error: true });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={close} title={existing ? "Rename folder" : "New folder"}>
      <input
        className="text-input"
        aria-label="Folder name"
        placeholder="Folder name"
        value={name}
        autoFocus
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && name.trim() && void save()}
      />
      {!existing && folders.length > 0 && (
        <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 16 }}>
          Inside
          <select value={parent} onChange={(e) => setParent(e.target.value === "" ? "" : Number(e.target.value))}>
            <option value="">(top level)</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>{f.path}</option>
            ))}
          </select>
        </label>
      )}
      <div className="buttons">
        <button type="button" className="btn btn-text" onClick={close}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={!name.trim() || busy} onClick={() => void save()}>
          {existing ? "Rename" : "Create"}
        </button>
      </div>
    </Modal>
  );
}

/** Debounced value, for search-as-you-type inputs. */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
