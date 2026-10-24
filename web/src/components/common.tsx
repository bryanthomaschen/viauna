import * as Dialog from "@radix-ui/react-dialog";
import * as Tooltip from "@radix-ui/react-tooltip";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { type ButtonHTMLAttributes, type ReactNode, forwardRef, useEffect, useState } from "react";
import { type ConfirmRequest, ui, useAccount } from "../lib/account";
import { api } from "../lib/api";
import { avatarColor, initial } from "../lib/format";
import { folderPath, navigate } from "../lib/router";
import { dismissToast, prefs, toast, toasts } from "../lib/store";
import type { Address, Label, Mailbox } from "../lib/types";
import { MOD_KEY } from "./CommandMenu";
import { CALENDAR_SHORTCUTS, SHORTCUTS } from "./shortcuts";

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


/** The help panel: the command menu, which always works, then the single-key shortcuts and their switch. */
function ShortcutsHelp() {
  const on = prefs.use((p) => p.shortcuts);
  return (
    <>
      <p className="dialog-text shortcut-intro">
        <kbd>{MOD_KEY}K</kbd> opens the command menu: type what you want to do, or a folder or label, and press Enter.
      </p>
      <div className="shortcut-switch">
        <span>Single-key shortcuts are {on ? "on" : "off"}.</span>
        <button type="button" className="btn btn-text" onClick={() => prefs.set((p) => ({ ...p, shortcuts: !on }))}>
          {on ? "Turn off" : "Turn on"}
        </button>
      </div>
      <div className={`shortcut-grid ${on ? "" : "off"}`}>
        {SHORTCUTS.map(([k, v]) => (
          <div key={k}>
            <span>{v}</span>
            <kbd>{k}</kbd>
          </div>
        ))}
      </div>
      <h3 className="shortcut-heading">In the calendar</h3>
      <div className={`shortcut-grid ${on ? "" : "off"}`}>
        {CALENDAR_SHORTCUTS.map(([k, v]) => (
          <div key={k}>
            <span>{v}</span>
            <kbd>{k}</kbd>
          </div>
        ))}
      </div>
    </>
  );
}

export function Dialogs() {
  const state = ui.use();
  return (
    <>
      <Modal open={state.shortcutsOpen} onClose={() => ui.set((s) => ({ ...s, shortcutsOpen: false }))} title="Keyboard shortcuts">
        <ShortcutsHelp />
      </Modal>
      {state.labelDialog && <LabelDialog />}
      {state.folderDialog && <FolderDialog />}
      {state.confirm && <ConfirmDialog request={state.confirm} />}
    </>
  );
}

function ConfirmDialog({ request }: { request: ConfirmRequest }) {
  const [busy, setBusy] = useState(false);
  const close = () => ui.set((s) => ({ ...s, confirm: null }));
  const go = async () => {
    setBusy(true);
    try {
      await request.run();
      close();
    } catch (err) {
      toast((err as Error).message, { error: true });
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={close} title={request.title}>
      <p className="dialog-text">{request.body}</p>
      <div className="buttons">
        <button type="button" className="btn btn-text" onClick={close}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={busy} autoFocus onClick={() => void go()}>{request.action}</button>
      </div>
    </Modal>
  );
}

/** Leaves a label's or folder's view (or a conversation in it) once it no longer exists. */
function leaveIfViewing(account: number, path: string) {
  if (location.pathname === path || location.pathname.startsWith(`${path}/`)) navigate(folderPath(account, { kind: "inbox" }));
}

export function confirmRemoveLabel(client: QueryClient, account: number, label: Label) {
  ui.set((s) => ({
    ...s,
    confirm: {
      title: `Remove the label "${label.name}"?`,
      body: "It comes off every conversation that has it. The conversations themselves stay where they are.",
      action: "Remove",
      run: async () => {
        await api.deleteLabel(account, label.keyword);
        leaveIfViewing(account, folderPath(account, { kind: "label", keyword: label.keyword }));
        void client.invalidateQueries({ queryKey: ["mailboxes", account] });
        void client.invalidateQueries({ queryKey: ["threads", account] });
      },
    },
  }));
}

export function confirmDeleteFolder(client: QueryClient, account: number, folder: Mailbox, mailboxes: Mailbox[]) {
  const children = mailboxes.some((m) => m.parentPath === folder.path);
  const contents = folder.total ? ` and the ${folder.total.toLocaleString()} ${folder.total === 1 ? "message" : "messages"} in it` : "";
  ui.set((s) => ({
    ...s,
    confirm: {
      title: `Delete the folder "${folder.name}"?`,
      body: `"${folder.path}"${contents} will be deleted from your mail server. This can't be undone.${children ? " Its subfolders are kept." : ""}`,
      action: "Delete",
      run: async () => {
        await api.deleteMailbox(account, folder.id);
        leaveIfViewing(account, folderPath(account, { kind: "folder", id: folder.id }));
        void client.invalidateQueries({ queryKey: ["mailboxes", account] });
      },
    },
  }));
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
  const parentId = ui.use((s) => s.folderDialog?.parentId);
  const [name, setName] = useState(existing?.name ?? "");
  const [parent, setParent] = useState<number | "">(parentId ?? "");
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
    <Modal open onClose={close} title={existing ? "Rename folder" : parentId ? "New subfolder" : "New folder"}>
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
          <select className="text-input" value={parent} onChange={(e) => setParent(e.target.value === "" ? "" : Number(e.target.value))}>
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

/** A phone's screen, as the stylesheet's narrow rules have it (`max-width: 720px`). */
const NARROW = "(max-width: 720px)";
export const narrow = () => matchMedia(NARROW).matches;

/** Whether the screen is a phone's, after a resize too. */
export function useNarrow() {
  const [is, setIs] = useState(narrow);
  useEffect(() => {
    const media = matchMedia(NARROW);
    const change = () => setIs(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  return is;
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
