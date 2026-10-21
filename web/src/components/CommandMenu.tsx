// The command menu, ⌘K on a Mac and Ctrl+K elsewhere: every action, folder, label and
// setting by name. Type a few letters and press Enter. It's the keyboard route that
// doesn't need single-key shortcuts turned on, and it says which shortcut does the same.
import { Command } from "cmdk";
import {
  ArrowRight, BookUser, CalendarDays, CalendarPlus, CircleUserRound, Folder, Inbox, Keyboard, ListFilter, type LucideIcon, Monitor, Moon, Pencil, Plus, Rows3, Search,
  Settings, Shield, Star, Sun, Tag, Undo2, Upload,
} from "lucide-react";
import { useMemo, useState } from "react";
import { ui, useAccount } from "../lib/account";
import { undoLast } from "../lib/actions";
import { openCompose } from "../lib/compose";
import { useConfig } from "../lib/config";
import { type Folder as FolderRoute, calendarPath, folderPath, navigate } from "../lib/router";
import { prefs } from "../lib/store";
import { type ViewCommand, viewHandlers } from "./shortcuts";

export const MOD_KEY = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘" : "Ctrl+";

interface Item {
  label: string;
  icon: LucideIcon;
  key?: string;
  keywords?: string[];
  run: () => void;
}

const MAILBOXES: [FolderRoute["kind"], string, string?][] = [
  ["inbox", "Inbox", "i"],
  ["starred", "Starred", "s"],
  ["sent", "Sent", "t"],
  ["drafts", "Drafts", "d"],
  ["all", "All Mail", "a"],
  ["archive", "Archive"],
  ["spam", "Spam"],
  ["trash", "Trash"],
];

export function CommandMenu() {
  const open = ui.use((s) => s.commandsOpen);
  if (!open) return null;
  return <Menu />;
}

function Menu() {
  const acct = useAccount();
  const config = useConfig().data;
  const p = prefs.use((x) => x);
  const [q, setQ] = useState("");
  // What the visible conversation or selection offers, as it was when the menu opened.
  const view = useMemo(() => viewHandlers().commands?.() ?? null, []);
  const close = () => ui.set((s) => ({ ...s, commandsOpen: false }));
  // The menu closes first and gives focus back, then the command runs, so a picker or
  // dialog it opens isn't closed along with it.
  const run = (fn: () => void) => {
    close();
    setTimeout(fn, 0);
  };
  const go = (to: string) => () => navigate(to);
  const a = acct.index;

  const goTo: Item[] = [
    ...MAILBOXES.filter(([kind]) => kind !== "archive" || acct.special.archive).map(([kind, label, key]) => ({
      label,
      icon: kind === "inbox" ? Inbox : kind === "starred" ? Star : Folder,
      key: key && `g then ${key}`,
      run: go(folderPath(a, { kind } as FolderRoute)),
    })),
    ...acct.mailboxes
      .filter((m) => !m.specialUse && m.selectable)
      .sort((x, y) => x.path.localeCompare(y.path))
      .map((m) => ({ label: m.path, icon: Folder, keywords: ["folder"], run: go(folderPath(a, { kind: "folder", id: m.id })) })),
    ...acct.labels.map((l) => ({ label: l.name, icon: Tag, keywords: ["label"], run: go(folderPath(a, { kind: "label", keyword: l.keyword })) })),
    ...(config?.calendar ? [{ label: "Calendar", icon: CalendarDays, keywords: ["events"], run: go(calendarPath(a)) }] : []),
    ...(config?.contacts ? [{ label: "Contacts", icon: BookUser, run: go(`/u/${a}/contacts`) }] : []),
    { label: "Settings", icon: Settings, run: go(`/u/${a}/settings`) },
    ...(config?.filters ? [{ label: "Filters", icon: ListFilter, keywords: ["vacation", "rules"], run: go(`/u/${a}/settings?tab=filters`) }] : []),
    ...(acct.accounts.some((x) => x.admin) ? [{ label: "Admin", icon: Shield, keywords: ["server"], run: go("/admin") }] : []),
    ...acct.accounts
      .map((x, i) => ({ x, i }))
      .filter(({ i }) => i !== a)
      .map(({ x, i }) => ({ label: `Switch to ${x.email}`, icon: CircleUserRound, keywords: ["account"], run: go(`/u/${i}/inbox`) })),
  ];

  const create: Item[] = [
    { label: "Compose", icon: Pencil, key: "c", keywords: ["new message", "write"], run: () => openCompose(a, acct.identities[0], acct.settings?.signature ?? "", {}) },
    { label: "New label", icon: Plus, run: () => ui.set((s) => ({ ...s, labelDialog: {} })) },
    { label: "New folder", icon: Plus, run: () => ui.set((s) => ({ ...s, folderDialog: {} })) },
    ...(config?.contacts ? [{ label: "New contact", icon: Plus, run: () => ui.set((s) => ({ ...s, contactDialog: {} })) }] : []),
    ...(config?.calendar
      ? [
          { label: "New event", icon: CalendarPlus, keywords: ["meeting", "appointment"], run: () => ui.set((s) => ({ ...s, eventDialog: { initial: {} } })) },
          { label: "Import events from a file", icon: Upload, keywords: ["ics", "calendar"], run: () => ui.set((s) => ({ ...s, importDialog: true })) },
        ]
      : []),
  ];

  const set = <K extends keyof typeof p>(k: K, v: (typeof p)[K]) => () => prefs.set((x) => ({ ...x, [k]: v }));
  const settings: Item[] = [
    { label: "Undo last action", icon: Undo2, key: "z", run: undoLast },
    p.shortcuts
      ? { label: "Turn off single-key shortcuts", icon: Keyboard, keywords: ["keyboard"], run: set("shortcuts", false) }
      : { label: "Turn on single-key shortcuts", icon: Keyboard, keywords: ["keyboard"], run: set("shortcuts", true) },
    { label: "Show keyboard shortcuts", icon: Keyboard, key: "?", keywords: ["help"], run: () => ui.set((s) => ({ ...s, shortcutsOpen: true })) },
    ...(
      [
        ["light", "Light theme", Sun],
        ["dark", "Dark theme", Moon],
        ["system", "Theme from your system", Monitor],
      ] as const
    )
      .filter(([v]) => v !== p.theme)
      .map(([v, label, icon]) => ({ label, icon, keywords: ["appearance", "colour", "color"], run: set("theme", v) })),
    ...(
      [
        ["default", "Default density"],
        ["comfortable", "Comfortable density"],
        ["compact", "Compact density"],
      ] as const
    )
      .filter(([v]) => v !== p.density)
      .map(([v, label]) => ({ label, icon: Rows3, keywords: ["rows", "spacing"], run: set("density", v) })),
  ];

  const row = (group: string, item: Item | ViewCommand, i: number) => (
    <Command.Item
      key={`${group}:${i}`}
      value={`${group}: ${item.label}`}
      keywords={"keywords" in item ? item.keywords : undefined}
      onSelect={() => run(item.run)}
    >
      <item.icon size={18} aria-hidden />
      <span className="cmdk-label">{item.label}</span>
      {p.shortcuts && item.key && <kbd>{item.key}</kbd>}
    </Command.Item>
  );

  return (
    <Command.Dialog
      open
      onOpenChange={(o) => !o && close()}
      label="Command menu"
      overlayClassName="dialog-overlay"
      contentClassName="cmdk"
      loop
    >
      <div className="cmdk-input">
        <Search size={18} aria-hidden />
        <Command.Input value={q} onValueChange={setQ} placeholder="Type a command, folder or label…" />
        <kbd>Esc</kbd>
      </div>
      <Command.List>
        {view && view.items.length > 0 && (
          <Command.Group heading={view.target}>{view.items.map((item, i) => row(view.target, item, i))}</Command.Group>
        )}
        <Command.Group heading="Go to">{goTo.map((item, i) => row("Go to", item, i))}</Command.Group>
        <Command.Group heading="Create">{create.map((item, i) => row("Create", item, i))}</Command.Group>
        <Command.Group heading="Settings">{settings.map((item, i) => row("Settings", item, i))}</Command.Group>
        {/* Last, so Enter runs a matching command first; alone when nothing else matches. */}
        {q.trim() && (
          <Command.Group heading="Search" forceMount>
            <Command.Item forceMount value={`search: ${q}`} onSelect={() => run(go(folderPath(a, { kind: "search", query: q.trim() })))}>
              <Search size={18} aria-hidden />
              <span className="cmdk-label">Search mail for “{q.trim()}”</span>
              <ArrowRight size={16} aria-hidden />
            </Command.Item>
          </Command.Group>
        )}
      </Command.List>
    </Command.Dialog>
  );
}
