// Gmail's keyboard shortcuts, off until turned on in Settings, and ⌘K / Ctrl+K for the
// command menu, always on. The visible view (list or conversation) registers the
// handlers that make sense for it; this module maps keys to them.
import type { LucideIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { ui, useAccount } from "../lib/account";
import { undoLast } from "../lib/actions";
import { openCompose } from "../lib/compose";
import { type Route, folderPath, navigate } from "../lib/router";
import { prefs } from "../lib/store";

/** The single-key shortcuts as the help panel lists them (and docs/using/shortcuts.md, which a test keeps the same). */
export const SHORTCUTS: [string, string][] = [
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

export interface ViewHandlers {
  next?: () => void;
  prev?: () => void;
  open?: () => void;
  back?: () => void;
  archive?: () => void;
  trash?: () => void;
  spam?: () => void;
  star?: () => void;
  select?: () => void;
  read?: () => void;
  unread?: () => void;
  label?: () => void;
  move?: () => void;
  reply?: () => void;
  replyAll?: () => void;
  forward?: () => void;
  nextMessage?: () => void;
  prevMessage?: () => void;
  escape?: () => void;
  /** For the command menu: what the view's commands act on, and the commands that apply now. */
  commands?: () => ViewCommands | null;
}

export interface ViewCommand {
  label: string;
  icon: LucideIcon;
  /** Its single-key shortcut, shown beside it when shortcuts are on. */
  key?: string;
  run: () => void;
}

export interface ViewCommands {
  /** "Weekend hike", "3 conversations": the heading over them. */
  target: string;
  items: ViewCommand[];
}

const none: { current: ViewHandlers } = { current: {} };
let active = none;

/** Registers the current view's handlers; the latest render's closures always win. */
export function useViewHandlers(handlers: ViewHandlers) {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    active = ref;
    return () => {
      if (active === ref) active = none;
    };
  });
}

/** The visible view's handlers, for the command menu. */
export const viewHandlers = (): ViewHandlers => active.current;

/** Whether the list's cursor bar is showing: someone is steering with the keyboard. */
export const steeringByKeyboard = () => document.documentElement.dataset.keyboard !== undefined;

/**
 * The list's cursor bar is only for people steering with the keyboard: a shortcut
 * shows it, the next click or tap hides it (like the browser's :focus-visible).
 */
function keyboardMode(on: boolean) {
  if (on) document.documentElement.dataset.keyboard = "";
  else delete document.documentElement.dataset.keyboard;
}

/** Inputs that take typed text; a ticked checkbox or a pressed button doesn't. */
const TEXT_INPUTS = /^(text|search|email|url|tel|password|number|date|datetime-local|month|time|week)$/;

function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  if (el.isContentEditable || el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
  if (el.tagName === "INPUT") return TEXT_INPUTS.test((el as HTMLInputElement).type);
  return !!el.closest("[contenteditable=true], [role=dialog], [role=menu]");
}

/** Something on screen that Escape should close first: a dialog, a menu, a picker. */
const layerOpen = () => !!document.querySelector("[role=dialog], [role=menu], [role=listbox]");

/** The command menu: ⌘K on a Mac, Ctrl+K elsewhere, whether or not shortcuts are on. */
export function useCommandMenuKey() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.shiftKey || e.key.toLowerCase() !== "k" || !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      ui.set((s) => ({ ...s, commandsOpen: !s.commandsOpen, shortcutsOpen: false }));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export function useShortcuts(route: Route) {
  const acct = useAccount();
  const enabled = prefs.use((p) => p.shortcuts);
  const gPressed = useRef(0);
  const acctRef = useRef(acct);
  acctRef.current = acct;

  useEffect(() => {
    if (!enabled) return;
    // A focused button's tooltip closes on Escape and marks the key as handled; it isn't
    // something Escape should stop at. So whether anything else was open is noted
    // before any of them sees the key.
    let escapeFree = false;
    const before = (e: KeyboardEvent) => {
      if (e.key === "Escape") escapeFree = !layerOpen();
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.defaultPrevented && !(e.key === "Escape" && escapeFree)) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (typing(e.target)) {
        if (e.key === "Escape") (e.target as HTMLElement).blur?.();
        return;
      }
      const a = acctRef.current;
      const k = e.key;
      const go = (kind: "inbox" | "starred" | "sent" | "drafts" | "all") => navigate(folderPath(a.index, { kind }));
      if (Date.now() - gPressed.current < 1500) {
        gPressed.current = 0;
        const map: Record<string, "inbox" | "starred" | "sent" | "drafts" | "all"> = { i: "inbox", s: "starred", t: "sent", d: "drafts", a: "all" };
        if (map[k]) {
          e.preventDefault();
          keyboardMode(true);
          go(map[k]);
          return;
        }
      }
      const h = active.current;
      const run = (fn?: () => void) => {
        if (!fn) return;
        e.preventDefault();
        keyboardMode(true);
        fn();
      };
      switch (k) {
        case "g": gPressed.current = Date.now(); return;
        case "c":
          e.preventDefault();
          openCompose(a.index, a.identities[0], a.settings?.signature ?? "", {});
          return;
        case "/":
          e.preventDefault();
          ui.set((s) => ({ ...s, searchFocus: s.searchFocus + 1 }));
          return;
        case "?":
          e.preventDefault();
          ui.set((s) => ({ ...s, shortcutsOpen: true }));
          return;
        case "z": return run(undoLast);
        case "j": return run(h.next);
        case "k": return run(h.prev);
        case "o": case "Enter": return run(h.open);
        case "u": return run(h.back);
        case "e": return run(h.archive);
        case "#": return run(h.trash);
        case "!": return run(h.spam);
        case "s": return run(h.star);
        case "x": return run(h.select);
        case "I": return run(h.read);
        case "U": return run(h.unread);
        case "l": return run(h.label);
        case "v": return run(h.move);
        case "r": return run(h.reply);
        case "a": return run(h.replyAll);
        case "f": return run(h.forward);
        case "n": return run(h.nextMessage);
        case "p": return run(h.prevMessage);
        case "Escape": return run(h.escape);
      }
    };
    window.addEventListener("keydown", before, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", before, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [enabled, route]);

  // Separate from the key handler, which re-subscribes on every route change: `u`
  // back to the list must keep the bar, so only a click, a tap or turning
  // shortcuts off clears it.
  useEffect(() => {
    if (!enabled) return;
    const onPointer = () => keyboardMode(false);
    window.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("pointerdown", onPointer, true);
      keyboardMode(false);
    };
  }, [enabled]);
}
