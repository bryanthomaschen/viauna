// Gmail's keyboard shortcuts. The visible view (list or conversation) registers the
// handlers that make sense for it; this module maps keys to them.
import { useEffect, useRef } from "react";
import { ui, useAccount } from "../lib/account";
import { undoLast } from "../lib/actions";
import { openCompose } from "../lib/compose";
import { type Route, folderPath, navigate } from "../lib/router";
import { prefs } from "../lib/store";

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
}

let active: ViewHandlers = {};

/** Registers the current view's handlers; the latest render's closures always win. */
export function useViewHandlers(handlers: ViewHandlers) {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    const proxy: ViewHandlers = {};
    for (const key of Object.keys(ref.current) as (keyof ViewHandlers)[]) {
      proxy[key] = () => ref.current[key]?.();
    }
    active = proxy;
    return () => {
      if (active === proxy) active = {};
    };
  });
}

function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || !!el.closest("[contenteditable=true], [role=dialog], [role=menu]");
}

export function useShortcuts(route: Route) {
  const acct = useAccount();
  const enabled = prefs.use((p) => p.shortcuts);
  const gPressed = useRef(0);
  const acctRef = useRef(acct);
  acctRef.current = acct;

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
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
          go(map[k]);
          return;
        }
      }
      const h = active;
      const run = (fn?: () => void) => {
        if (!fn) return;
        e.preventDefault();
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
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, route]);
}
